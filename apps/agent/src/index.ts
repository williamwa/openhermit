import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { stderr } from 'node:process';

import { createAdaptorServer } from '@hono/node-server';

import type { RuntimeStateFile } from '@openhermit/shared';

import { AgentRunner } from './agent-runner.js';
import { createAgentApp } from './app.js';
import { AgentSecurity, AgentWorkspace } from './core/index.js';
import { initializeInternalStateDatabase } from './internal-state/sqlite.js';
import {
  createLangfuseClientFromEnv,
  createLangfuseShutdownHandler,
  loadEnvironmentFile,
  resolveAgentEnvPath,
} from './langfuse.js';
import {
  createBeforeExitLangfuseHandler,
  createExitRuntimeFileCleanupHandler,
  createSignalShutdownHandler,
} from './process-lifecycle.js';
import { assertRuntimeMetadataAbsent } from './runtime-metadata.js';

const defaultPort = 3001;
type NodeFetchCallback = Parameters<typeof createAdaptorServer>[0]['fetch'];

const logStartup = (message: string): void => {
  console.log(`[openhermit-agent] ${message}`);
};

const listen = async (
  fetch: NodeFetchCallback,
  preferredPort: number,
): Promise<{
  server: ReturnType<typeof createAdaptorServer>;
  info: AddressInfo;
  usedFallback: boolean;
}> => {
  const listenOnce = (
    port: number,
  ): Promise<{ server: ReturnType<typeof createAdaptorServer>; info: AddressInfo }> =>
    new Promise<{ server: ReturnType<typeof createAdaptorServer>; info: AddressInfo }>((resolve, reject) => {
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

  try {
    const result = await listenOnce(preferredPort);

    return {
      server: result.server,
      info: result.info,
      usedFallback: false,
    };
  } catch (error) {
    if (
      preferredPort !== 0 &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EADDRINUSE'
    ) {
      const fallbackResult = await listenOnce(0);

      return {
        server: fallbackResult.server,
        info: fallbackResult.info,
        usedFallback: true,
      };
    }

    throw error;
  }
};

export const main = async (): Promise<void> => {
  const agentEnvPath = resolveAgentEnvPath();
  const loadedEnvCount = await loadEnvironmentFile(agentEnvPath);

  if (loadedEnvCount > 0) {
    logStartup(`loaded ${loadedEnvCount} environment variable(s) from ${agentEnvPath}`);
  }

  const agentId = process.env.OPENHERMIT_AGENT_ID ?? 'agent-dev';
  const workspaceRoot =
    process.env.OPENHERMIT_WORKSPACE_ROOT ??
    path.join(process.cwd(), '.openhermit-dev', agentId);
  const agentName =
    process.env.OPENHERMIT_AGENT_NAME ?? 'OpenHermit Dev Agent';

  const workspace = new AgentWorkspace(workspaceRoot);
  logStartup(`booting agent ${agentId}`);
  logStartup(`workspace root: ${workspaceRoot}`);
  await workspace.init({
    agentId,
    name: agentName,
  });

  const security = new AgentSecurity({
    agentId,
    workspace,
  });
  await security.init();
  await security.load();
  const config = await security.readConfig();
  initializeInternalStateDatabase(security.stateFilePath).close();
  logStartup(`internal state: ${security.stateFilePath}`);
  logStartup(`internal config: ${security.configFilePath}`);
  logStartup(`runtime metadata: ${security.runtimeFilePath}`);
  logStartup(`autonomy: ${security.getAutonomyLevel()}`);
  await assertRuntimeMetadataAbsent(security.runtimeFilePath);

  const langfuse = createLangfuseClientFromEnv({
    logger: logStartup,
  });

  const shutdownLangfuse = createLangfuseShutdownHandler(langfuse);

  if (langfuse) {
    logStartup('Langfuse tracing enabled for model requests');
  }

  const runner = await AgentRunner.create({
    workspace,
    security,
    ...(langfuse ? { langfuse } : {}),
  });

  const rawPort = process.env.PORT;
  const preferredPort = rawPort
    ? Number.parseInt(rawPort, 10)
    : config.http_api.preferred_port || defaultPort;

  if (Number.isNaN(preferredPort)) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }

  logStartup(
    `preferred port: ${preferredPort}${rawPort ? ' (from PORT env)' : ' (from config/default)'}`,
  );

  const apiToken = randomBytes(24).toString('hex');
  const app = createAgentApp(runner, { apiToken });
  const { server, info, usedFallback } = await listen(app.fetch, preferredPort);

  const shutdownHandler = createSignalShutdownHandler({
    server,
    shutdownLangfuse,
    cleanup: async () => {
      await fs.rm(security.runtimeFilePath, { force: true });
    },
    logger: logStartup,
  });
  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);
  process.on('beforeExit', createBeforeExitLangfuseHandler(shutdownLangfuse));
  process.on('exit', createExitRuntimeFileCleanupHandler(security.runtimeFilePath, logStartup));

  const runtimeState: RuntimeStateFile = {
    http_api: {
      port: info.port,
      token: apiToken,
    },
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(
    security.runtimeFilePath,
    `${JSON.stringify(runtimeState, null, 2)}\n`,
    'utf8',
  );

  logStartup(
    `listening on http://localhost:${info.port}${
      usedFallback ? `; preferred port ${preferredPort} was unavailable` : ''
    }`,
  );
  logStartup(`agent name: ${agentName}`);
  logStartup(`token written to runtime.json`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
