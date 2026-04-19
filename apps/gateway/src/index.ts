import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stderr } from 'node:process';
import { LogBuffer } from './log-buffer.js';

import { createAdaptorServer } from '@hono/node-server';

import { DbAgentStore } from '@openhermit/store';

import { loadEnvironmentFile } from '@openhermit/agent/langfuse';

import { AgentInstanceManager } from './agent-instance.js';
import { createGatewayApp } from './app.js';
import { loadGatewayConfig } from './config.js';
import { attachGatewayWs } from './ws-handler.js';
import {
  type AuthResolverOptions,
  ChannelRegistry,
  DeviceKeyAuthProvider,
  createJwtConfig,
} from './auth.js';

const DEFAULT_CONFIG_FILENAME = 'gateway.json';

type NodeFetchCallback = Parameters<typeof createAdaptorServer>[0]['fetch'];

const logBuffer = new LogBuffer();
const logStartup = logBuffer.wrap((message: string): void => {
  console.log(`[openhermit-gateway] ${message}`);
});


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
  // Load .env from the project root (falls back gracefully if missing).
  const gatewayEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
  const loadedEnvCount = await loadEnvironmentFile(gatewayEnvPath);
  if (loadedEnvCount > 0) {
    logStartup(`loaded ${loadedEnvCount} env var(s) from ${gatewayEnvPath}`);
  }

  // Load gateway.json (env vars override for secrets/port).
  const homeDir = process.env.OPENHERMIT_HOME ?? `${process.env.HOME ?? '/root'}/.openhermit`;
  const configPath = path.join(homeDir, DEFAULT_CONFIG_FILENAME);
  const config = await loadGatewayConfig(configPath);
  logStartup(`config loaded from ${configPath}`);

  const instances = new AgentInstanceManager();

  // Open agent store if DATABASE_URL is available.
  let agentStore: DbAgentStore | undefined;
  if (process.env.DATABASE_URL) {
    try {
      agentStore = await DbAgentStore.open();
      logStartup('agent store connected');
    } catch (error) {
      logStartup(`agent store unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Auth configuration (secrets stay in env).
  const channels = new ChannelRegistry();
  const jwtConfig = createJwtConfig(process.env.GATEWAY_JWT_SECRET);
  if (!process.env.GATEWAY_JWT_SECRET) {
    logStartup('GATEWAY_JWT_SECRET not set — using ephemeral secret (tokens will not survive restarts)');
  }
  const adminToken = process.env.GATEWAY_ADMIN_TOKEN;

  const auth: AuthResolverOptions = {
    userProviders: [new DeviceKeyAuthProvider()],
    channels,
    jwt: jwtConfig,
    adminToken,
  };
  if (!adminToken) {
    logStartup('GATEWAY_ADMIN_TOKEN not set — admin API endpoints are disabled');
  }

  const gatewayDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = config.ui ? path.resolve(gatewayDir, '../ui/dist') : undefined;

  const app = createGatewayApp({
    instances,
    ...(agentStore ? { agentStore } : {}),
    auth,
    adminToken,
    logger: logStartup,
    logBuffer,
    publicDir,
    corsOrigin: config.cors.origin,
  });

  if (config.ui) {
    logStartup('admin UI enabled at /admin/');
  }

  const rawPort = process.env.GATEWAY_PORT ?? process.env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : 4000;

  if (Number.isNaN(port)) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const { server, info } = await listen(app.fetch, port);

  // Set the gateway base URL so channel adapters can connect back.
  instances.setGatewayBaseUrl(`http://localhost:${info.port}`);

  attachGatewayWs(server as import('node:http').Server, {
    instances,
    auth,
    logger: logStartup,
  });

  // Start agents from database after server is listening (channels need the gateway URL).
  if (agentStore && config.autoStartAgents) {
    const dbAgents = await agentStore.list();
    for (const agent of dbAgents) {
      try {
        await instances.start(agent.agentId, agent.configDir, agent.workspaceDir);
        logStartup(`started agent: ${agent.agentId}`);
      } catch (error) {
        logStartup(`failed to start agent ${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    logStartup(`${dbAgents.length} agent(s) loaded`);
  } else if (agentStore && !config.autoStartAgents) {
    logStartup('autoStartAgents disabled — agents will not be started automatically');
  }

  const shutdownHandler = async (): Promise<void> => {
    logStartup('shutting down...');

    await instances.stopAll();
    await agentStore?.close();

    server.close(() => {
      logStartup('server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdownHandler());
  process.on('SIGTERM', () => void shutdownHandler());

  logStartup(`listening on http://localhost:${info.port}`);
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
