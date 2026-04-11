import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { stderr } from 'node:process';

import { createAdaptorServer } from '@hono/node-server';

import { AgentRegistry } from './agent-registry.js';
import { AgentLifecycle } from './agent-lifecycle.js';
import { createGatewayApp } from './app.js';

const defaultPort = 4000;

type NodeFetchCallback = Parameters<typeof createAdaptorServer>[0]['fetch'];

const logStartup = (message: string): void => {
  console.log(`[openhermit-gateway] ${message}`);
};

interface GatewayAgentConfig {
  agentId: string;
  workspaceRoot?: string;
  port?: number;
}

interface GatewayConfig {
  agents?: GatewayAgentConfig[];
}

const resolveConfigPath = (): string => {
  if (process.env.OPENHERMIT_GATEWAY_CONFIG) {
    return process.env.OPENHERMIT_GATEWAY_CONFIG;
  }

  const baseDir =
    process.env.OPENHERMIT_HOME ?? path.join(os.homedir(), '.openhermit');
  return path.join(baseDir, 'gateway.json');
};

const loadConfig = async (): Promise<GatewayConfig> => {
  const configPath = resolveConfigPath();

  try {
    const content = await fs.readFile(configPath, 'utf8');
    logStartup(`loaded config from ${configPath}`);
    return JSON.parse(content) as GatewayConfig;
  } catch {
    logStartup(`no config found at ${configPath}, starting with empty registry`);
    return {};
  }
};

const listen = (
  fetch: NodeFetchCallback,
  port: number,
): Promise<{ server: ReturnType<typeof createAdaptorServer>; info: AddressInfo }> =>
  new Promise((resolve, reject) => {
    const server = createAdaptorServer({ fetch });

    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };

    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      reject(error);
    };

    const onListening = (): void => {
      cleanup();
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve bound server address.'));
        return;
      }

      resolve({ server, info: address });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });

export const main = async (): Promise<void> => {
  const config = await loadConfig();
  const registry = new AgentRegistry();
  const lifecycle = new AgentLifecycle({ registry, logger: logStartup });

  // Register agents from config.
  if (config.agents) {
    for (const agentConfig of config.agents) {
      const regConfig: { workspaceRoot?: string; port?: number } = {};

      if (agentConfig.workspaceRoot) {
        regConfig.workspaceRoot = agentConfig.workspaceRoot;
      }

      if (agentConfig.port !== undefined) {
        regConfig.port = agentConfig.port;
      }

      registry.register(agentConfig.agentId, regConfig);
      logStartup(`registered agent: ${agentConfig.agentId}`);
    }
  }

  const app = createGatewayApp({ registry, lifecycle, logger: logStartup });

  const rawPort = process.env.GATEWAY_PORT ?? process.env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : defaultPort;

  if (Number.isNaN(port)) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const { server, info } = await listen(app.fetch, port);

  const shutdownHandler = async (): Promise<void> => {
    logStartup('shutting down...');

    await lifecycle.stopAll();

    server.close(() => {
      logStartup('server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdownHandler());
  process.on('SIGTERM', () => void shutdownHandler());

  logStartup(`listening on http://localhost:${info.port}`);
  logStartup(
    `${registry.list().length} agent(s) registered`,
  );
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().catch((error) => {
    stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
