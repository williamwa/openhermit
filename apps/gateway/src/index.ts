import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stderr } from 'node:process';
import { LogBuffer } from './log-buffer.js';

import { createAdaptorServer } from '@hono/node-server';

import {
  DbAgentStore,
  DbAgentConfigStore,
  DbMcpServerStore,
  DbScheduleStore,
  DbSkillStore,
  DbUserStore,
  FileSecretStore,
} from '@openhermit/store';
import { scanSkillDirectory } from '@openhermit/agent/skills';

import { loadEnv, resolveOpenHermitHome } from '@openhermit/shared';

import { AgentInstanceManager } from './agent-instance.js';
import { syncSkillMounts } from './skill-mounts.js';
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
    server.listen(port, '127.0.0.1');
  });

export const main = async (): Promise<void> => {
  // Load .env: ~/.openhermit/.env (production) then cwd/.env (development).
  const loadedEnvCount = await loadEnv();
  if (loadedEnvCount > 0) {
    logStartup(`loaded ${loadedEnvCount} env var(s)`);
  }

  // Load gateway.json.
  const homeDir = resolveOpenHermitHome();
  const configPath = path.join(homeDir, DEFAULT_CONFIG_FILENAME);
  const config = await loadGatewayConfig(configPath);
  logStartup(`config loaded from ${configPath}`);

  const instances = new AgentInstanceManager();

  // Open agent store and skill store if DATABASE_URL is available.
  let agentStore: DbAgentStore | undefined;
  let skillStore: DbSkillStore | undefined;
  let scheduleStore: DbScheduleStore | undefined;
  let mcpServerStore: DbMcpServerStore | undefined;
  let userStore: DbUserStore | undefined;
  let configStore: DbAgentConfigStore | undefined;
  if (process.env.DATABASE_URL) {
    try {
      agentStore = await DbAgentStore.open();
      skillStore = await DbSkillStore.open();
      scheduleStore = await DbScheduleStore.open();
      mcpServerStore = await DbMcpServerStore.open();
      userStore = await DbUserStore.open();
      configStore = await DbAgentConfigStore.open();
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

  // Pass skill store to instances so agent runners can access DB skills.
  if (mcpServerStore) {
    instances.setMcpServerStore(mcpServerStore);
  }

  if (configStore) {
    instances.setConfigStore(configStore);
    // FileSecretStore needs to know each agent's configDir; resolve via
    // the agentStore so we don't take a hard dep on filesystem layout.
    const secretStore = new FileSecretStore(async (agentId: string) => {
      const record = await agentStore?.get(agentId);
      if (!record) throw new Error(`Agent not found: ${agentId}`);
      return record.configDir;
    });
    instances.setSecretStore(secretStore);
  }

  if (skillStore) {
    instances.setSkillStore(skillStore);

    // Auto-register built-in skills into DB.
    const builtinSkillsDir = path.resolve(gatewayDir, '../../../skills');
    const builtinSkills = await scanSkillDirectory(builtinSkillsDir, builtinSkillsDir, 'system');
    for (const skill of builtinSkills) {
      const now = new Date().toISOString();
      await skillStore.upsert({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (builtinSkills.length > 0) {
      logStartup(`registered ${builtinSkills.length} built-in skill(s)`);
    }
  }

  const app = createGatewayApp({
    instances,
    ...(agentStore ? { agentStore } : {}),
    ...(skillStore ? { skillStore } : {}),
    ...(scheduleStore ? { scheduleStore } : {}),
    ...(mcpServerStore ? { mcpServerStore } : {}),
    ...(userStore ? { userStore } : {}),
    ...(configStore ? { configStore } : {}),
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

  // Set the gateway base URL, admin token, and channel registry so channel adapters can connect back.
  instances.setGatewayBaseUrl(`http://localhost:${info.port}`);
  instances.setAdminToken(adminToken);
  instances.setChannelRegistry(channels);

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
    // Sync skill-mounts symlinks for all agents.
    if (skillStore) {
      for (const agent of dbAgents) {
        const skillMountsDir = `${agent.configDir}/skill-mounts`;
        await syncSkillMounts(agent.agentId, skillMountsDir, skillStore);
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
    await skillStore?.close();
    await scheduleStore?.close();
    await mcpServerStore?.close();

    server.close(() => {
      logStartup('server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdownHandler());
  process.on('SIGTERM', () => void shutdownHandler());

  // Don't let a single agent's runtime error take down the entire
  // gateway — log loudly and keep running. Real fixes belong at the
  // throw site; these handlers are operational safety nets so other
  // agents stay online.
  process.on('uncaughtException', (err) => {
    console.error('[openhermit-gateway] uncaughtException — keeping gateway alive', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[openhermit-gateway] unhandledRejection — keeping gateway alive', reason);
  });

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
