import { promises as fs } from 'node:fs';
import path from 'node:path';

export const readRuntimeValue = async (
  workspaceRoot: string,
  relativePath: string,
): Promise<string> => {
  const filePath = path.join(workspaceRoot, relativePath);
  return (await fs.readFile(filePath, 'utf8')).trim();
};
