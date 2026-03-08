import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const outputDirectories = new Set(['dist', 'dist-test']);

const workspaceRoot = process.cwd();

const candidates = [
  path.join(workspaceRoot, 'apps'),
  path.join(workspaceRoot, 'packages'),
];

const removeOutputs = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory() && outputDirectories.has(entry.name)) {
      await rm(absolutePath, { recursive: true, force: true });
      continue;
    }

    if (entry.isDirectory()) {
      await removeOutputs(absolutePath);
    }
  }
};

await Promise.all(candidates.map((directory) => removeOutputs(directory)));
