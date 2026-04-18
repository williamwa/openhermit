import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stderr } from 'node:process';

import { createAdaptorServer } from '@hono/node-server';

import { DbAgentStore } from '@openhermit/store';

import { loadEnvironmentFile } from '@openhermit/agent/langfuse';

import { AgentInstanceManager } from './agent-instance.js';
import { createGatewayApp } from './app.js';
import { attachGatewayWs } from './ws-handler.js';
import {
  type AuthResolverOptions,
  ChannelRegistry,
  DeviceKeyAuthProvider,
} from './auth.js';

const defaultPort = 4000;

type NodeFetchCallback = Parameters<typeof createAdaptorServer>[0]['fetch'];

const logStartup = (message: string): void => {
  console.log(`[openhermit-gateway] ${message}`);
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
  // Load .env from the project root (falls back gracefully if missing).
  const gatewayEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
  const loadedEnvCount = await loadEnvironmentFile(gatewayEnvPath);
  if (loadedEnvCount > 0) {
    logStartup(`loaded ${loadedEnvCount} env var(s) from ${gatewayEnvPath}`);
  }

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

  // Auth configuration
  const channels = new ChannelRegistry();
  const auth: AuthResolverOptions = {
    userProviders: [new DeviceKeyAuthProvider()],
    channels,
  };

  const app = createGatewayApp({
    instances,
    ...(agentStore ? { agentStore } : {}),
    auth,
    logger: logStartup,
  });

  const rawPort = process.env.GATEWAY_PORT ?? process.env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : defaultPort;

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
  if (agentStore) {
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
