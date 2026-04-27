import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

import type { Command } from 'commander';
import { resolveOpenHermitHome } from '@openhermit/shared';

// ── Helpers ────────────────────────────────────────────────────────────

const rl = (): readline.Interface =>
  readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (prompt: string, defaultValue?: string): Promise<string> =>
  new Promise((resolve) => {
    const iface = rl();
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    iface.question(`${prompt}${suffix}: `, (answer) => {
      iface.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });

const choose = async (prompt: string, options: string[]): Promise<number> => {
  console.log(`\n${prompt}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i]}`);
  }
  const answer = await ask('Choose', '1');
  const index = Number.parseInt(answer, 10) - 1;
  return index >= 0 && index < options.length ? index : 0;
};

const commandExists = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile('which', [cmd], (error) => resolve(!error));
  });

const generateToken = (): string => crypto.randomBytes(24).toString('base64url');

// ── .env helpers ───────────────────────────────────────────────────────

const resolveEnvPath = (): string =>
  // Persisted env lives in the user's OpenHermit home, never in cwd. The
  // shared loadEnv() reads from this path on every CLI invocation, so all
  // \`hermit ...\` commands and the gateway/web they spawn pick it up.
  path.join(resolveOpenHermitHome(), '.env');

const fileExists = (p: string): Promise<boolean> =>
  access(p).then(() => true, () => false);

const DEFAULT_GATEWAY_CONFIG = {
  ui: true,
  cors: { origin: '*' },
  autoStartAgents: true,
};

const ensureGatewayConfig = async (): Promise<{ created: boolean; path: string }> => {
  const home = resolveOpenHermitHome();
  const configPath = path.join(home, 'gateway.json');
  if (await fileExists(configPath)) return { created: false, path: configPath };
  await mkdir(home, { recursive: true });
  await writeFile(configPath, JSON.stringify(DEFAULT_GATEWAY_CONFIG, null, 2) + '\n', 'utf8');
  return { created: true, path: configPath };
};

const readEnvFile = async (envPath: string): Promise<Map<string, string>> => {
  const env = new Map<string, string>();
  try {
    const content = await readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes.
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env.set(key, value);
    }
  } catch {
    // File doesn't exist yet — that's fine.
  }
  return env;
};

const writeEnvFile = async (envPath: string, env: Map<string, string>): Promise<void> => {
  await mkdir(path.dirname(envPath), { recursive: true });
  const lines: string[] = [];
  for (const [key, value] of env) {
    // Quote values that contain spaces or special chars.
    const needsQuote = /[\s#"']/.test(value);
    lines.push(needsQuote ? `${key}="${value}"` : `${key}=${value}`);
  }
  await writeFile(envPath, lines.join('\n') + '\n', 'utf8');
};

// ── Local Postgres via docker run ──────────────────────────────────────

const DOCKER_CONTAINER_NAME = 'openhermit-postgres';
const DOCKER_VOLUME_NAME = 'openhermit-pgdata';
const DOCKER_HOST_PORT = '5433';
const DOCKER_DB_URL = `postgresql://openhermit:dev@localhost:${DOCKER_HOST_PORT}/openhermit`;

const dockerContainerState = (): Promise<'running' | 'stopped' | 'absent'> =>
  new Promise((resolve) => {
    execFile(
      'docker',
      ['inspect', '-f', '{{.State.Status}}', DOCKER_CONTAINER_NAME],
      (error, stdout) => {
        if (error) { resolve('absent'); return; }
        const status = stdout.trim();
        resolve(status === 'running' ? 'running' : 'stopped');
      },
    );
  });

const startExistingContainer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    console.log(`\nStarting existing container ${DOCKER_CONTAINER_NAME}...`);
    const child = spawn('docker', ['start', DOCKER_CONTAINER_NAME], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker start exited with code ${code}`)),
    );
  });

const runNewContainer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    console.log('\nLaunching PostgreSQL via docker run...');
    const args = [
      'run', '-d',
      '--name', DOCKER_CONTAINER_NAME,
      '-e', 'POSTGRES_USER=openhermit',
      '-e', 'POSTGRES_PASSWORD=dev',
      '-e', 'POSTGRES_DB=openhermit',
      '-p', `127.0.0.1:${DOCKER_HOST_PORT}:5432`,
      '-v', `${DOCKER_VOLUME_NAME}:/var/lib/postgresql/data`,
      'postgres:16-alpine',
    ];
    const child = spawn('docker', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker run exited with code ${code}`)),
    );
  });

const waitForPostgresReady = async (databaseUrl: string, timeoutMs = 30000): Promise<void> => {
  const pg = await import('pg');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new pg.default.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('PostgreSQL did not become ready within 30s');
};

const ensureDockerPostgres = async (): Promise<void> => {
  const state = await dockerContainerState();
  if (state === 'running') {
    console.log(`  → ${DOCKER_CONTAINER_NAME} is already running`);
  } else if (state === 'stopped') {
    await startExistingContainer();
  } else {
    await runNewContainer();
  }
  console.log('  → waiting for PostgreSQL to accept connections...');
  await waitForPostgresReady(DOCKER_DB_URL);
  console.log('  → PostgreSQL is ready');
};

// ── Setup command ──────────────────────────────────────────────────────

export const registerSetupCommand = (program: Command): void => {
  program
    .command('setup')
    .description('Interactive gateway setup wizard')
    .action(async () => {
      console.log('OpenHermit Gateway Setup\n');

      const envPath = resolveEnvPath();
      const env = await readEnvFile(envPath);
      let changed = false;

      // ── Step 1: Database ──────────────────────────────────────────

      const existingDbUrl = env.get('DATABASE_URL');
      if (existingDbUrl) {
        console.log(`DATABASE_URL is already set: ${existingDbUrl}`);
        const keep = await ask('Keep this value? (y/n)', 'y');
        if (keep.toLowerCase() !== 'n') {
          console.log('  → keeping existing DATABASE_URL');
        } else {
          env.delete('DATABASE_URL');
        }
      }

      if (!env.has('DATABASE_URL')) {
        console.log('OpenHermit requires a PostgreSQL database for agents,');
        console.log('sessions, schedules, and skills. Migrations run automatically');
        console.log('on gateway startup; you only need to point it at a server.\n');

        const options = [
          'Enter a DATABASE_URL manually',
          'Start a local PostgreSQL with Docker (postgres:16-alpine)',
        ];
        const choice = await choose('How would you like to set up the database?', options);

        if (choice === 0) {
          const url = await ask('DATABASE_URL');
          if (url) {
            env.set('DATABASE_URL', url);
            changed = true;
          } else {
            console.log('  ✗ no DATABASE_URL provided — aborting setup.');
            process.exit(1);
          }
        } else {
          if (!(await commandExists('docker'))) {
            console.error('  ✗ docker is not installed or not on PATH.');
            console.error('    Install Docker (https://docs.docker.com/get-docker/) and re-run \`openhermit setup\`,');
            console.error('    or pick option 1 to point at an existing PostgreSQL.');
            process.exit(1);
          }
          await ensureDockerPostgres();
          env.set('DATABASE_URL', DOCKER_DB_URL);
          changed = true;
          console.log(`  → DATABASE_URL=${DOCKER_DB_URL}`);
        }
      }

      // ── Step 2: Admin token ───────────────────────────────────────

      console.log('');
      const existingToken = env.get('GATEWAY_ADMIN_TOKEN');
      if (existingToken) {
        console.log(`GATEWAY_ADMIN_TOKEN is already set: ${existingToken.slice(0, 8)}...`);
        const keep = await ask('Keep this value? (y/n)', 'y');
        if (keep.toLowerCase() !== 'n') {
          console.log('  → keeping existing token');
        } else {
          env.delete('GATEWAY_ADMIN_TOKEN');
        }
      }

      if (!env.has('GATEWAY_ADMIN_TOKEN')) {
        const generated = generateToken();
        const options = [
          `Generate a random token (${generated.slice(0, 12)}...)`,
          'Enter a token manually',
        ];
        const choice = await choose('Gateway admin token:', options);

        if (choice === 0) {
          env.set('GATEWAY_ADMIN_TOKEN', generated);
          changed = true;
          console.log(`  → GATEWAY_ADMIN_TOKEN=${generated}`);
        } else {
          const token = await ask('GATEWAY_ADMIN_TOKEN');
          if (token) {
            env.set('GATEWAY_ADMIN_TOKEN', token);
            changed = true;
          }
        }
      }

      // ── Step 3: JWT secret (auto-generate if missing) ─────────────

      if (!env.has('GATEWAY_JWT_SECRET')) {
        const secret = generateToken();
        env.set('GATEWAY_JWT_SECRET', secret);
        changed = true;
        console.log(`\n  → GATEWAY_JWT_SECRET generated (tokens will persist across restarts)`);
      }

      // ── Step 3b: Secrets encryption key (auto-generate if missing) ──

      if (!env.has('OPENHERMIT_SECRETS_KEY')) {
        // 32 random bytes, base64-encoded. Used by DbSecretStore (AES-256-GCM)
        // to encrypt every per-agent secret value at rest in postgres.
        const secretsKey = crypto.randomBytes(32).toString('base64');
        env.set('OPENHERMIT_SECRETS_KEY', secretsKey);
        changed = true;
        console.log(`  → OPENHERMIT_SECRETS_KEY generated (encrypts agent secrets in DB; back this up!)`);
      }

      // Also set OPENHERMIT_TOKEN = admin token for CLI convenience.
      const adminToken = env.get('GATEWAY_ADMIN_TOKEN');
      if (adminToken && !env.has('OPENHERMIT_TOKEN')) {
        env.set('OPENHERMIT_TOKEN', adminToken);
        changed = true;
      }

      // ── Write .env ────────────────────────────────────────────────

      if (changed) {
        await writeEnvFile(envPath, env);
        console.log(`\n✓ Saved to ${envPath}`);
      } else {
        console.log('\nNo changes made.');
      }

      // ── Step 4: gateway.json (minimal default if missing) ─────────

      const cfg = await ensureGatewayConfig();
      if (cfg.created) {
        console.log(`✓ Wrote default gateway config: ${cfg.path}`);
      } else {
        console.log(`  Gateway config already present: ${cfg.path}`);
      }

      console.log('\nNext steps:');
      console.log('  hermit gateway start   Start the gateway (background)');
      console.log('  hermit web start       Start the web UI (background)');
      console.log('  hermit status          Check platform status');
      console.log('  hermit doctor          Verify environment');
    });
};
