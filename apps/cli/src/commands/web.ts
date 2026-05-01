import { spawn } from 'node:child_process';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';
import { resolveOpenHermitHome } from '@openhermit/shared';

import { handleError } from './shared.js';

// ── Helpers ────────────────────────────────────────────────────────────

const cliDir = path.dirname(fileURLToPath(import.meta.url));

const isTsxDev = process.execArgv.some((a) => a.includes('tsx'));

const resolveWebSpawn = async (): Promise<{ bin: string; args: string[] }> => {
  if (!isTsxDev) {
    // 1. Bundled web (npm-installed package): dist/web.js next to dist/cli.js
    const bundledEntry = path.resolve(cliDir, '../dist/web.js');
    try {
      await access(bundledEntry);
      return { bin: process.execPath, args: [bundledEntry] };
    } catch { /* not bundled — try monorepo paths */ }

    // 2. Monorepo built: apps/web/dist/index.js
    const monoDistEntry = path.resolve(cliDir, '../../../web/dist/index.js');
    try {
      await access(monoDistEntry);
      return { bin: process.execPath, args: [monoDistEntry] };
    } catch { /* not built — fall back to source */ }
  }

  // 3. Monorepo dev: apps/web/src/index.ts via tsx
  const monoSrcEntry = path.resolve(cliDir, '../../../web/src/index.ts');
  return { bin: process.execPath, args: ['-C', 'development', '--import', 'tsx', monoSrcEntry] };
};

const resolveHomeDir = resolveOpenHermitHome;

const pidFilePath = (): string => path.join(resolveHomeDir(), 'web.pid');

const logFilePath = (): string => path.join(resolveHomeDir(), 'web.log');

const resolveWebUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const port = env.OPENHERMIT_WEB_PORT ?? env.PORT ?? '4310';
  return `http://127.0.0.1:${port}`;
};

const readPid = async (): Promise<number | null> => {
  try {
    const content = await readFile(pidFilePath(), 'utf8');
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const removePidFile = async (): Promise<void> => {
  try { await unlink(pidFilePath()); } catch { /* already gone */ }
};

// ── Command ────────────────────────────────────────────────────────────

export const registerWebCommand = (program: Command): void => {
  const web = program
    .command('web')
    .description('Web UI lifecycle management');

  // --- start (background) ---
  web
    .command('start')
    .description('Start the web UI in the background')
    .option('-p, --port <port>', 'Listen port (overrides OPENHERMIT_WEB_PORT, default 4310)')
    .option('-H, --host <host>', 'Listen host (overrides OPENHERMIT_WEB_HOST, default 127.0.0.1; use 0.0.0.0 to expose publicly)')
    .action(async (opts: { port?: string; host?: string }) => {
      try {
        const existingPid = await readPid();
        if (existingPid && isProcessAlive(existingPid)) {
          console.log(`Web is already running (pid ${existingPid}).`);
          return;
        }

        const { bin, args } = await resolveWebSpawn();
        const home = resolveHomeDir();
        await mkdir(home, { recursive: true });

        const logFile = logFilePath();
        const { openSync } = await import('node:fs');
        const out = openSync(logFile, 'a');
        const err = openSync(logFile, 'a');

        const env: NodeJS.ProcessEnv = { ...process.env };
        if (opts.port) env.OPENHERMIT_WEB_PORT = opts.port;
        if (opts.host) env.OPENHERMIT_WEB_HOST = opts.host;

        const child = spawn(bin, args, {
          detached: true,
          stdio: ['ignore', out, err],
          env,
        });

        child.unref();

        if (!child.pid) {
          console.error('Failed to start web — no pid returned.');
          process.exit(1);
        }

        await writeFile(pidFilePath(), String(child.pid), 'utf8');

        const port = opts.port ?? env.OPENHERMIT_WEB_PORT ?? env.PORT ?? '4310';
        const host = opts.host ?? env.OPENHERMIT_WEB_HOST ?? '127.0.0.1';
        console.log(`Web started (pid ${child.pid}).`);
        console.log(`Listening on http://${host}:${port}`);
        if (host === '0.0.0.0') {
          console.log('  (bound to 0.0.0.0 — reachable from any network interface)');
        }
        console.log(`Logs: ${logFile}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- stop ---
  web
    .command('stop')
    .description('Stop the background web UI')
    .action(async () => {
      const pid = await readPid();
      if (!pid) {
        console.log('No web pid file found. Is the web server running?');
        process.exit(1);
      }

      if (!isProcessAlive(pid)) {
        console.log(`Web process (pid ${pid}) is not running. Cleaning up pid file.`);
        await removePidFile();
        return;
      }

      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to web (pid ${pid}).`);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await new Promise((r) => setTimeout(r, 200));
      }

      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL');
        console.log('Process did not exit in time — sent SIGKILL.');
      }

      await removePidFile();
      console.log('Web stopped.');
    });

  // --- run (foreground) ---
  web
    .command('run')
    .description('Start the web UI in the foreground (for development)')
    .action(async () => {
      try {
        const { bin, args } = await resolveWebSpawn();
        const child = spawn(bin, args, {
          stdio: 'inherit',
          env: { ...process.env },
        });

        child.on('error', (errr) => {
          console.error(`Failed to start web: ${errr.message}`);
          process.exit(1);
        });

        child.on('exit', (code) => {
          process.exit(code ?? 0);
        });

        const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
        process.on('SIGINT', () => forward('SIGINT'));
        process.on('SIGTERM', () => forward('SIGTERM'));
      } catch (error) {
        handleError(error);
      }
    });

  // --- status ---
  web
    .command('status')
    .description('Check whether the web UI is running')
    .action(async () => {
      const url = resolveWebUrl();
      const pid = await readPid();
      const pidInfo = pid && isProcessAlive(pid) ? ` (pid ${pid})` : '';

      try {
        const response = await fetch(url);
        if (response.ok) {
          console.log(`Web:  ✓ running at ${url}${pidInfo}`);
        } else {
          console.log(`Web:  ✗ responded with ${response.status}`);
          process.exit(1);
        }
      } catch {
        console.log(`Web:  ✗ not reachable at ${url}`);
        if (pid && !isProcessAlive(pid)) {
          console.log(`      Stale pid file (pid ${pid}). Cleaning up.`);
          await removePidFile();
        }
        process.exit(1);
      }
    });
};
