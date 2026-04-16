import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { stderr } from 'node:process';

import { createAdaptorServer } from '@hono/node-server';

import { DbAgentStore } from '@openhermit/store';

import { AgentRegistry } from './agent-registry.js';
import { AgentLifecycle } from './agent-lifecycle.js';
import { createGatewayApp } from './app.js';
import { attachGatewayWsProxy } from './ws-proxy.js';

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
  const registry = new AgentRegistry();
  const lifecycle = new AgentLifecycle({ registry, logger: logStartup });

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

  // Load agents from database into registry.
  if (agentStore) {
    const dbAgents = await agentStore.list();
    for (const agent of dbAgents) {
      registry.register(agent.agentId, {
        ...(agent.name ? { name: agent.name } : {}),
        configDir: agent.configDir,
        workspaceDir: agent.workspaceDir,
      });
      logStartup(`registered agent from db: ${agent.agentId}`);
    }
  }

  // Discover already-running agents or start them.
  for (const entry of registry.list()) {
    const discovered = await lifecycle.discover(entry.agentId);

    if (discovered) {
      logStartup(`discovered running agent: ${entry.agentId} on port ${discovered.port}`);
    } else {
      try {
        const started = await lifecycle.start(entry.agentId);
        logStartup(`started agent: ${entry.agentId} on port ${started.port}`);
      } catch (error) {
        logStartup(`failed to start agent ${entry.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const app = createGatewayApp({
    registry,
    lifecycle,
    ...(agentStore ? { agentStore } : {}),
    logger: logStartup,
  });

  const rawPort = process.env.GATEWAY_PORT ?? process.env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : defaultPort;

  if (Number.isNaN(port)) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const { server, info } = await listen(app.fetch, port);

  attachGatewayWsProxy(server as import('node:http').Server, {
    registry,
    lifecycle,
    logger: logStartup,
  });

  const shutdownHandler = async (): Promise<void> => {
    logStartup('shutting down...');

    await lifecycle.stopAll();
    await agentStore?.close();

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
