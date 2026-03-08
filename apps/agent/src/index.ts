import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';

import { runtimeFiles } from '@openhermit/shared';

import { AgentRunner } from './agent-runner.js';
import { createAgentApp } from './app.js';
import { AgentSecurity, AgentWorkspace } from './core/index.js';

const defaultPort = 3001;
type NodeFetchCallback = Parameters<typeof createAdaptorServer>[0]['fetch'];

const listen = async (
  fetch: NodeFetchCallback,
  preferredPort: number,
): Promise<{ info: AddressInfo; usedFallback: boolean }> => {
  const listenOnce = (port: number): Promise<AddressInfo> =>
    new Promise<AddressInfo>((resolve, reject) => {
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

        resolve(address);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    });

  try {
    return {
      info: await listenOnce(preferredPort),
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
      return {
        info: await listenOnce(0),
        usedFallback: true,
      };
    }

    throw error;
  }
};

const agentId = process.env.OPENHERMIT_AGENT_ID ?? 'agent-dev';
const workspaceRoot =
  process.env.OPENHERMIT_WORKSPACE_ROOT ??
  path.join(process.cwd(), '.openhermit-dev', agentId);
const agentName =
  process.env.OPENHERMIT_AGENT_NAME ?? 'OpenHermit Dev Agent';

const workspace = new AgentWorkspace(workspaceRoot);
await workspace.init({
  agentId,
  name: agentName,
});
const config = await workspace.readConfig();

const security = new AgentSecurity({
  agentId,
  workspace,
});
await security.init();
await security.load();

const runner = await AgentRunner.create({
  workspace,
  security,
});

const rawPort = process.env.PORT;
const preferredPort = rawPort
  ? Number.parseInt(rawPort, 10)
  : config.http_api.preferred_port || defaultPort;

if (Number.isNaN(preferredPort)) {
  throw new Error(`Invalid PORT value: ${rawPort}`);
}

const apiToken = randomBytes(24).toString('hex');
const app = createAgentApp(runner, { apiToken });
const { info, usedFallback } = await listen(app.fetch, preferredPort);

await Promise.all([
  workspace.writeFile(runtimeFiles.apiToken, `${apiToken}\n`),
  workspace.writeFile(runtimeFiles.apiPort, `${info.port}\n`),
]);

console.log(
  `[openhermit-agent] listening on http://localhost:${info.port} (workspace: ${workspaceRoot})${
    usedFallback ? `; preferred port ${preferredPort} was unavailable` : ''
  }`,
);
