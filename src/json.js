import { readFile } from 'node:fs/promises';

export async function readJsonFile(filePath) {
  const raw = await readFile(filePath, 'utf8');

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}
