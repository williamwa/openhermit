import { serve } from '@hono/node-server';

import { createAgentApp } from './app.js';

const defaultPort = 3001;
const rawPort = process.env.PORT;
const port = rawPort ? Number.parseInt(rawPort, 10) : defaultPort;

if (Number.isNaN(port)) {
  throw new Error(`Invalid PORT value: ${rawPort}`);
}

const app = createAgentApp();

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(
      `[cloudmind-agent] listening on http://localhost:${info.port}`,
    );
  },
);
