import { defineConfig } from 'tsup';

const internalPackages = [
  '@openhermit/sdk',
  '@openhermit/shared',
  '@openhermit/protocol',
  '@openhermit/store',
  '@openhermit/agent',
  '@openhermit/agent/*',
  '@openhermit/web',
  '@openhermit/channel-telegram',
  '@openhermit/gateway',
];

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    gateway: '../../apps/gateway/src/index.ts',
    web: '../../apps/web/src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: true,
  noExternal: internalPackages,
  external: [/generated\/prisma/],
  banner: ({ entryPoint }) =>
    entryPoint?.endsWith('cli.ts')
      ? { js: '#!/usr/bin/env node' }
      : {},
});
