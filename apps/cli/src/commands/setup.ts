import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

import type { Command } from 'commander';

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

const fileExists = (filePath: string): Promise<boolean> =>
  access(filePath).then(() => true, () => false);

const generateToken = (): string => crypto.randomBytes(24).toString('base64url');

// ── .env helpers ───────────────────────────────────────────────────────

const resolveEnvPath = (): string => {
  // The gateway loads .env from the project root (3 levels up from gateway/src/index.ts).
  // In the monorepo that's the repo root.  For standalone installs we use cwd.
  return path.resolve(process.cwd(), '.env');
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
  const lines: string[] = [];
  for (const [key, value] of env) {
    // Quote values that contain spaces or special chars.
    const needsQuote = /[\s#"']/.test(value);
    lines.push(needsQuote ? `${key}="${value}"` : `${key}=${value}`);
  }
  await writeFile(envPath, lines.join('\n') + '\n', 'utf8');
};

// ── Docker Compose ─────────────────────────────────────────────────────

const DOCKER_COMPOSE_DB_URL = 'postgresql://openhermit:dev@localhost:5433/openhermit';

const isComposeRunning = (): Promise<boolean> =>
  new Promise((resolve) => {
    execFile('docker', ['compose', 'ps', '--format', 'json', '--filter', 'status=running'], (error, stdout) => {
      if (error) { resolve(false); return; }
      resolve(stdout.includes('postgres'));
    });
  });

const startCompose = (): Promise<void> =>
  new Promise((resolve, reject) => {
    console.log('\nStarting PostgreSQL via docker compose...');
    const child = spawn('docker', ['compose', 'up', '-d', 'postgres'], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker compose exited with code ${code}`)),
    );
  });

const runMigrations = async (databaseUrl: string): Promise<void> => {
  console.log('\nRunning database migrations...');
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { readFile: rf } = await import('node:fs/promises');
    const migrationDir = path.resolve(process.cwd(), 'packages/store/drizzle');
    const initSql = await rf(path.join(migrationDir, '0000_init.sql'), 'utf8');
    await client.query(initSql);
  } finally {
    await client.end();
  }
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
        const hasDocker = await commandExists('docker');
        const options = hasDocker
          ? [
              'Start a local PostgreSQL with docker compose (recommended)',
              'Enter a DATABASE_URL manually',
              'Skip (agent persistence will be disabled)',
            ]
          : [
              'Enter a DATABASE_URL manually',
              'Skip (agent persistence will be disabled)',
            ];

        const choice = await choose('How would you like to set up the database?', options);
        const label = options[choice]!;

        if (label.startsWith('Start a local')) {
          const running = await isComposeRunning();
          if (!running) {
            await startCompose();
          } else {
            console.log('  → PostgreSQL container is already running');
          }
          env.set('DATABASE_URL', DOCKER_COMPOSE_DB_URL);
          changed = true;
          console.log(`  → DATABASE_URL=${DOCKER_COMPOSE_DB_URL}`);
        } else if (label.startsWith('Enter')) {
          const url = await ask('DATABASE_URL');
          if (url) {
            env.set('DATABASE_URL', url);
            changed = true;
          }
        } else {
          console.log('  → skipping database setup');
        }
      }

      // Run migrations if we have a DATABASE_URL and the migrations directory exists.
      if (env.has('DATABASE_URL') && await fileExists(path.resolve(process.cwd(), 'packages/store/drizzle'))) {
        try {
          await runMigrations(env.get('DATABASE_URL')!);
          console.log('  → migrations applied');
        } catch (error) {
          console.error(`  ✗ migration failed: ${error instanceof Error ? error.message : String(error)}`);
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

      console.log('\nNext steps:');
      console.log('  hermit gateway run     Start the gateway');
      console.log('  hermit status          Check platform status');
      console.log('  hermit doctor          Verify environment');
    });
};
