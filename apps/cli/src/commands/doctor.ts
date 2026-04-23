import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';
import { resolveOpenHermitHome } from '@openhermit/shared';

import { resolveGatewayUrl } from './shared.js';

interface Check {
  label: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const commandExists = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile('which', [cmd], (error) => resolve(!error));
  });

const commandVersion = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, (error, stdout) => {
      resolve(error ? 'unknown' : stdout.trim().split('\n')[0] ?? 'unknown');
    });
  });

const buildChecks = (): Check[] => {
  const homeDir = resolveOpenHermitHome();

  return [
    {
      label: 'Node.js',
      run: async () => {
        const version = process.version;
        const major = Number.parseInt(version.slice(1), 10);
        return major >= 20
          ? { ok: true, detail: version }
          : { ok: false, detail: `${version} (requires >= 20)` };
      },
    },
    {
      label: 'Docker',
      run: async () => {
        const exists = await commandExists('docker');
        if (!exists) return { ok: false, detail: 'not installed' };
        const version = await commandVersion('docker', ['--version']);
        return { ok: true, detail: version };
      },
    },
    {
      label: 'Home directory',
      run: async () => {
        try {
          await access(homeDir);
          return { ok: true, detail: homeDir };
        } catch {
          return { ok: false, detail: `${homeDir} does not exist` };
        }
      },
    },
    {
      label: 'Gateway config',
      run: async () => {
        const configPath = path.join(homeDir, 'gateway.json');
        try {
          await access(configPath);
          return { ok: true, detail: configPath };
        } catch {
          return { ok: false, detail: `${configPath} not found` };
        }
      },
    },
    {
      label: 'DATABASE_URL',
      run: async () => {
        return process.env.DATABASE_URL
          ? { ok: true, detail: 'set' }
          : { ok: false, detail: 'not set — agent persistence disabled' };
      },
    },
    {
      label: 'GATEWAY_ADMIN_TOKEN',
      run: async () => {
        return process.env.GATEWAY_ADMIN_TOKEN
          ? { ok: true, detail: 'set' }
          : { ok: false, detail: 'not set — admin endpoints disabled' };
      },
    },
    {
      label: 'Gateway reachable',
      run: async () => {
        const url = resolveGatewayUrl();
        try {
          const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
          return response.ok
            ? { ok: true, detail: url }
            : { ok: false, detail: `${url} responded with ${response.status}` };
        } catch {
          return { ok: false, detail: `${url} not reachable` };
        }
      },
    },
  ];
};

export const registerDoctorCommand = (program: Command): void => {
  program
    .command('doctor')
    .description('Check environment and dependencies')
    .action(async () => {
      console.log('Running health checks...\n');
      const checks = buildChecks();
      let failures = 0;

      for (const check of checks) {
        const result = await check.run();
        const icon = result.ok ? '✓' : '✗';
        console.log(`  ${icon} ${check.label.padEnd(22)} ${result.detail}`);
        if (!result.ok) failures += 1;
      }

      console.log('');
      if (failures === 0) {
        console.log('All checks passed.');
      } else {
        console.log(`${failures} check(s) failed.`);
        process.exit(1);
      }
    });
};
