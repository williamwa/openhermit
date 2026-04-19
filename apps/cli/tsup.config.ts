import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  // Bundle all internal monorepo packages into the output.
  // Keep true npm dependencies external — they'll be installed by npm.
  noExternal: [
    '@openhermit/sdk',
    '@openhermit/shared',
    '@openhermit/protocol',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
