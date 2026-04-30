import type { Command } from 'commander';

import { createGateway, handleError } from './shared.js';

// ── Helpers ────────────────────────────────────────────────────────────

/** Walk up the commander parent chain to find --agent. */
const resolveAgentId = (cmd: Command): string => {
  let current: Command | null = cmd;
  while (current) {
    const opts = current.opts() as Record<string, unknown>;
    if (typeof opts.agent === 'string') return opts.agent;
    current = current.parent;
  }
  return process.env.OPENHERMIT_AGENT_ID ?? 'main';
};

/**
 * Get a nested value from an object by dot-separated path.
 * e.g. getPath({ model: { provider: 'anthropic' } }, 'model.provider') → 'anthropic'
 */
const getPath = (obj: Record<string, unknown>, path: string): unknown => {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

/**
 * Set a nested value in an object by dot-separated path.
 * Creates intermediate objects as needed.
 */
const setPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
};

/** Try to parse a string as JSON, otherwise return it as a string. */
const parseValue = (raw: string): unknown => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;

  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== '') return num;

  if ((raw.startsWith('{') && raw.endsWith('}')) ||
      (raw.startsWith('[') && raw.endsWith(']'))) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }

  return raw;
};

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
};

// ── Command ────────────────────────────────────────────────────────────

export const registerConfigCommand = (program: Command): void => {
  const cfg = program
    .command('config')
    .description('View and modify agent configuration')
    .requiredOption('--agent <id>', 'Agent to configure', process.env.OPENHERMIT_AGENT_ID ?? 'main');

  // --- show ---
  cfg
    .command('show')
    .description('Show the full agent config')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const config = await gateway.getAgentConfig(agentId);
        console.log(JSON.stringify(config, null, 2));
      } catch (error) {
        handleError(error);
      }
    });

  // --- get ---
  cfg
    .command('get <key>')
    .description('Get a config value by dot-path (e.g. model.provider)')
    .action(async function (this: Command, key: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const config = await gateway.getAgentConfig(agentId);
        const value = getPath(config, key);
        if (value === undefined) {
          console.error(`Key not found: ${key}`);
          process.exit(1);
        }
        console.log(formatValue(value));
      } catch (error) {
        handleError(error);
      }
    });

  // --- set ---
  cfg
    .command('set <key> <value>')
    .description('Set a config value by dot-path (e.g. model.provider anthropic)')
    .action(async function (this: Command, key: string, rawValue: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const config = await gateway.getAgentConfig(agentId);
        const value = parseValue(rawValue);
        setPath(config, key, value);
        await gateway.putAgentConfig(agentId, config);
        console.log(`${key} = ${formatValue(value)}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- secrets ---
  const secrets = cfg
    .command('secrets')
    .description('Manage agent secrets');

  secrets
    .command('list')
    .description('List secret names (values are masked)')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const map = await gateway.getAgentSecrets(agentId);
        const keys = Object.keys(map).sort();
        if (keys.length === 0) {
          console.log('No secrets configured.');
          return;
        }
        // Values returned by the gateway are already masked.
        for (const key of keys) {
          console.log(`  ${key} = ${map[key]}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  secrets
    .command('set <key> <value>')
    .description('Set a secret (e.g. ANTHROPIC_API_KEY sk-...)')
    .action(async function (this: Command, key: string, value: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        await gateway.setAgentSecret(agentId, key, value);
        console.log(`Secret set: ${key}`);
      } catch (error) {
        handleError(error);
      }
    });

  secrets
    .command('remove <key>')
    .description('Remove a secret')
    .action(async function (this: Command, key: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        await gateway.deleteAgentSecret(agentId, key);
        console.log(`Secret removed: ${key}`);
      } catch (error) {
        handleError(error);
      }
    });

  // ── security ──────────────────────────────────────────────────────
  // Read / overwrite the agent's security policy: autonomy_level,
  // require_approval_for, access ('public' | 'protected' | 'private'),
  // access_token, channel_tokens.

  const security = cfg
    .command('security')
    .description('View and modify agent security policy');

  security
    .command('show')
    .description('Show the full security policy as JSON')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const policy = await gateway.getAgentSecurity(agentId);
        console.log(JSON.stringify(policy, null, 2));
      } catch (error) {
        handleError(error);
      }
    });

  security
    .command('get <key>')
    .description('Get a security policy value by dot-path (e.g. access)')
    .action(async function (this: Command, key: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const policy = await gateway.getAgentSecurity(agentId);
        const value = getPath(policy, key);
        if (value === undefined) {
          console.error(`Key not found: ${key}`);
          process.exit(1);
        }
        console.log(formatValue(value));
      } catch (error) {
        handleError(error);
      }
    });

  security
    .command('set <key> <value>')
    .description('Set a security policy value by dot-path (e.g. access private)')
    .action(async function (this: Command, key: string, rawValue: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const policy = await gateway.getAgentSecurity(agentId);
        const value = parseValue(rawValue);
        setPath(policy, key, value);
        await gateway.putAgentSecurity(agentId, policy);
        console.log(`${key} = ${formatValue(value)}`);
      } catch (error) {
        handleError(error);
      }
    });

  security
    .command('write')
    .description('Overwrite the entire security policy from stdin (JSON)')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          console.error('No JSON received on stdin.');
          process.exit(1);
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          console.error('Security policy must be a JSON object.');
          process.exit(1);
        }
        const gateway = createGateway();
        await gateway.putAgentSecurity(agentId, parsed as Record<string, unknown>);
        console.log('Security policy updated.');
      } catch (error) {
        handleError(error);
      }
    });
};
