import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';
import { resolveOpenHermitHome } from '@openhermit/shared';

import { resolveGatewayUrl, handleError } from './shared.js';

// ── Helpers ────────────────────────────────────────────────────────────

const cliDir = path.dirname(fileURLToPath(import.meta.url));

const resolveGatewaySpawn = async (): Promise<{ bin: string; args: string[] }> => {
  // 1. Bundled gateway (npm installed package): dist/gateway.js next to dist/cli.js
  const bundledEntry = path.resolve(cliDir, '../dist/gateway.js');
  try {
    await access(bundledEntry);
    return { bin: process.execPath, args: [bundledEntry] };
  } catch { /* not bundled — try monorepo paths */ }

  // 2. Monorepo built: apps/gateway/dist/index.js
  const monoDistEntry = path.resolve(cliDir, '../../../gateway/dist/index.js');
  try {
    await access(monoDistEntry);
    return { bin: process.execPath, args: [monoDistEntry] };
  } catch { /* not built — fall back to source */ }

  // 3. Monorepo dev: apps/gateway/src/index.ts via tsx
  const monoSrcEntry = path.resolve(cliDir, '../../../gateway/src/index.ts');
  return { bin: process.execPath, args: ['-C', 'development', '--import', 'tsx', monoSrcEntry] };
};

const resolveHomeDir = resolveOpenHermitHome;

const pidFilePath = (): string => path.join(resolveHomeDir(), 'gateway.pid');

const logFilePath = (): string => path.join(resolveHomeDir(), 'gateway.log');

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
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
};

const removePidFile = async (): Promise<void> => {
  try { await unlink(pidFilePath()); } catch { /* already gone */ }
};

// ── Command ────────────────────────────────────────────────────────────

export const registerGatewayCommand = (program: Command): void => {
  const gw = program
    .command('gateway')
    .description('Gateway lifecycle management');

  // --- start (background) ---
  gw
    .command('start')
    .description('Start the gateway in the background')
    .action(async () => {
      try {
        // Check if already running.
        const existingPid = await readPid();
        if (existingPid && isProcessAlive(existingPid)) {
          console.log(`Gateway is already running (pid ${existingPid}).`);
          return;
        }

        const { bin, args } = await resolveGatewaySpawn();
        const home = resolveHomeDir();
        await mkdir(home, { recursive: true });

        const logFile = logFilePath();
        const { openSync } = await import('node:fs');
        const out = openSync(logFile, 'a');
        const err = openSync(logFile, 'a');

        const child = spawn(bin, args, {
          detached: true,
          stdio: ['ignore', out, err],
          env: { ...process.env },
        });

        child.unref();

        if (!child.pid) {
          console.error('Failed to start gateway — no pid returned.');
          process.exit(1);
        }

        await writeFile(pidFilePath(), String(child.pid), 'utf8');
        console.log(`Gateway started (pid ${child.pid}).`);
        console.log(`Logs: ${logFile}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- stop ---
  gw
    .command('stop')
    .description('Stop the background gateway')
    .action(async () => {
      const pid = await readPid();
      if (!pid) {
        console.log('No gateway pid file found. Is the gateway running?');
        process.exit(1);
      }

      if (!isProcessAlive(pid)) {
        console.log(`Gateway process (pid ${pid}) is not running. Cleaning up pid file.`);
        await removePidFile();
        return;
      }

      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to gateway (pid ${pid}).`);

      // Wait briefly for the process to exit.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await new Promise((r) => setTimeout(r, 200));
      }

      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL');
        console.log('Process did not exit in time — sent SIGKILL.');
      }

      await removePidFile();
      console.log('Gateway stopped.');
    });

  // --- run (foreground) ---
  gw
    .command('run')
    .description('Start the gateway in the foreground (for development)')
    .action(async () => {
      try {
        const { bin, args } = await resolveGatewaySpawn();
        const child = spawn(bin, args, {
          stdio: 'inherit',
          env: { ...process.env },
        });

        child.on('error', (err) => {
          console.error(`Failed to start gateway: ${err.message}`);
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
  gw
    .command('status')
    .description('Check whether the gateway is running')
    .action(async () => {
      const url = resolveGatewayUrl();
      const pid = await readPid();
      const pidInfo = pid && isProcessAlive(pid) ? ` (pid ${pid})` : '';

      try {
        const response = await fetch(`${url}/health`);
        if (response.ok) {
          const data = await response.json() as { ok: boolean; role: string };
          console.log(`Gateway:  ✓ running at ${url}${pidInfo}`);
          console.log(`Health:   ${data.ok ? 'ok' : 'degraded'}`);
        } else {
          console.log(`Gateway:  ✗ responded with ${response.status}`);
          process.exit(1);
        }
      } catch {
        console.log(`Gateway:  ✗ not reachable at ${url}`);
        if (pid && !isProcessAlive(pid)) {
          console.log(`          Stale pid file (pid ${pid}). Cleaning up.`);
          await removePidFile();
        }
        process.exit(1);
      }
    });
};
