import { pathToFileURL } from 'node:url';

import { parseWebCliArgs } from './args.js';
import { createWebServer } from './server.js';

export { parseWebCliArgs, resolveWorkspaceRoot } from './args.js';
export { createWebServer } from './server.js';

export const main = async (): Promise<void> => {
  const options = parseWebCliArgs(process.argv.slice(2));
  const server = createWebServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });

  console.info(
    `[openhermit-web] http://127.0.0.1:${options.port} -> ${options.agentId} (${options.workspaceRoot})`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
