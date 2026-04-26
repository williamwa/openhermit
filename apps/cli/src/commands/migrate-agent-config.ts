import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { DbAgentStore, DbAgentConfigStore } from '@openhermit/store';

import { handleError } from './shared.js';

/**
 * One-shot import of legacy per-agent config.json / security.json into
 * the agents table. After this runs, the DB is the canonical source
 * for both documents and the legacy files can be removed.
 *
 * Idempotent: skips agents whose DB columns are already populated
 * unless --force is supplied.
 */
export const registerMigrateAgentConfigCommand = (program: Command): void => {
  program
    .command('migrate-agent-config')
    .description('Import legacy per-agent config.json and security.json into the agents table')
    .option('--force', 'overwrite DB columns even if already populated')
    .option('--dry-run', 'report what would be migrated without writing')
    .action(async (opts: { force?: boolean; dryRun?: boolean }) => {
      try {
        const agentStore = await DbAgentStore.open();
        const configStore = await DbAgentConfigStore.open();

        const agents = await agentStore.list();
        if (agents.length === 0) {
          console.log('No agents in the database.');
          await Promise.all([agentStore.close(), configStore.close()]);
          return;
        }

        let migrated = 0;
        let skipped = 0;
        let missing = 0;

        for (const agent of agents) {
          const configPath = path.join(agent.configDir, 'config.json');
          const securityPath = path.join(agent.configDir, 'security.json');

          const existingConfig = await configStore.getConfig(agent.agentId);
          const existingSecurity = await configStore.getSecurity(agent.agentId);

          const wantConfig = opts.force || !existingConfig;
          const wantSecurity = opts.force || !existingSecurity;

          if (!wantConfig && !wantSecurity) {
            console.log(`  ${agent.agentId}: already in DB, skipping`);
            skipped++;
            continue;
          }

          let configDoc: unknown = undefined;
          let securityDoc: unknown = undefined;

          if (wantConfig) {
            try {
              configDoc = JSON.parse(await fs.readFile(configPath, 'utf8'));
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') {
                console.log(`  ${agent.agentId}: ${configPath} not found`);
              } else {
                console.warn(`  ${agent.agentId}: failed to read config.json: ${(err as Error).message}`);
              }
            }
          }

          if (wantSecurity) {
            try {
              securityDoc = JSON.parse(await fs.readFile(securityPath, 'utf8'));
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') {
                console.log(`  ${agent.agentId}: ${securityPath} not found`);
              } else {
                console.warn(`  ${agent.agentId}: failed to read security.json: ${(err as Error).message}`);
              }
            }
          }

          if (configDoc === undefined && securityDoc === undefined) {
            missing++;
            continue;
          }

          if (opts.dryRun) {
            console.log(`  ${agent.agentId}: would migrate (config=${configDoc !== undefined}, security=${securityDoc !== undefined})`);
            continue;
          }

          if (configDoc !== undefined && configDoc !== null && typeof configDoc === 'object') {
            await configStore.setConfig(agent.agentId, configDoc as Record<string, unknown>);
          }
          if (securityDoc !== undefined && securityDoc !== null && typeof securityDoc === 'object') {
            await configStore.setSecurity(agent.agentId, securityDoc as Record<string, unknown>);
          }
          console.log(`  ${agent.agentId}: migrated`);
          migrated++;
        }

        console.log(`\n${migrated} migrated, ${skipped} already in DB, ${missing} missing/empty.`);
        await Promise.all([agentStore.close(), configStore.close()]);
      } catch (error) {
        handleError(error);
      }
    });
};
