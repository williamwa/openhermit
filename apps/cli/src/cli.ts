import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Command } from 'commander';

import { registerChatCommand } from './commands/chat.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerConfigCommand } from './commands/config.js';
import { registerSchedulesCommand } from './commands/schedules.js';

// ── Load .env (same behaviour as the gateway) ─────────────────────────

const loadEnvFile = async (filePath: string): Promise<void> => {
  let content: string;
  try { content = await readFile(filePath, 'utf8'); } catch { return; }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7) : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = normalized.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
};

await loadEnvFile(path.resolve(process.cwd(), '.env'));

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('hermit')
  .description('OpenHermit — multi-agent platform CLI')
  .version('0.1.0');

registerSetupCommand(program);
registerChatCommand(program);
registerAgentsCommand(program);
registerGatewayCommand(program);
registerConfigCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerLogsCommand(program);
registerSchedulesCommand(program);

await program.parseAsync(process.argv);
