import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { serve } from '@hono/node-server';

import { runtimeFiles } from '@cloudmind/shared';

import { createAgentApp } from './app.js';
import { AgentSecurity, AgentWorkspace } from './core/index.js';

const defaultPort = 3001;
const rawPort = process.env.PORT;
const port = rawPort ? Number.parseInt(rawPort, 10) : defaultPort;

if (Number.isNaN(port)) {
  throw new Error(`Invalid PORT value: ${rawPort}`);
}

const agentId = process.env.CLOUDMIND_AGENT_ID ?? 'agent-dev';
const workspaceRoot =
  process.env.CLOUDMIND_WORKSPACE_ROOT ??
  path.join(process.cwd(), '.cloudmind-dev', agentId);
const agentName = process.env.CLOUDMIND_AGENT_NAME ?? 'CloudMind Dev Agent';

const workspace = new AgentWorkspace(workspaceRoot);
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

const apiToken = randomBytes(24).toString('hex');
await workspace.writeFile(runtimeFiles.apiToken, `${apiToken}\n`);

const app = createAgentApp(undefined, { apiToken });

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    void workspace.writeFile(runtimeFiles.apiPort, `${info.port}\n`);
    console.log(
      `[cloudmind-agent] listening on http://localhost:${info.port} (workspace: ${workspaceRoot})`,
    );
  },
);
