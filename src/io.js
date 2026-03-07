import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const writeQueues = new Map();

export function enqueueFileWrite(filePath, task) {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);

  writeQueues.set(filePath, next);
  next.finally(() => {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  });

  return next;
}

export function writeTextAtomic(filePath, contents) {
  return enqueueFileWrite(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });

    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    await writeFile(tempPath, contents, 'utf8');
    await rename(tempPath, filePath);
  });
}

export function writeJsonAtomic(filePath, value) {
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonl(filePath, value) {
  return enqueueFileWrite(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await appendFile(filePath, `${serialized}\n`, 'utf8');
  });
}
