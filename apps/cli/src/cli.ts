import { Command } from 'commander';
import { loadEnv } from '@openhermit/shared';

import { registerChatCommand } from './commands/chat.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerWebCommand } from './commands/web.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerConfigCommand } from './commands/config.js';
import { registerSchedulesCommand } from './commands/schedules.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerMigrateAgentConfigCommand } from './commands/migrate-agent-config.js';

await loadEnv();

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('hermit')
  .description('OpenHermit — multi-agent platform CLI')
  .version('0.4.0');

registerSetupCommand(program);
registerChatCommand(program);
registerAgentsCommand(program);
registerGatewayCommand(program);
registerWebCommand(program);
registerConfigCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerLogsCommand(program);
registerSchedulesCommand(program);
registerSkillsCommand(program);
registerMcpCommand(program);
registerStatsCommand(program);
registerMigrateAgentConfigCommand(program);

await program.parseAsync(process.argv);
