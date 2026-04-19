import { Command } from 'commander';

import { registerChatCommand } from './commands/chat.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerConfigCommand } from './commands/config.js';

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

await program.parseAsync(process.argv);
