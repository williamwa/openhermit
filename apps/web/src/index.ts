import { pathToFileURL } from 'node:url';

import { loadEnv } from '@openhermit/shared';
import { createWebServer } from './server.js';

export { createWebServer } from './server.js';

const defaultPort = 4310;

export const main = async (): Promise<void> => {
  await loadEnv();
  const rawPort = process.env.OPENHERMIT_WEB_PORT ?? process.env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : defaultPort;

  if (Number.isNaN(port)) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const host = process.env.OPENHERMIT_WEB_HOST ?? '127.0.0.1';
  const server = createWebServer({ port });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  console.info(`[openhermit-web] http://${host}:${port}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
