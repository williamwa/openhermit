import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const writeQueues = new Map<string, Promise<unknown>>();

export function enqueueFileWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve<unknown>(undefined);
  const next = previous.catch(() => {}).then(task);

  writeQueues.set(filePath, next);
  next.finally(() => {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  });

  return next;
}

export function writeTextAtomic(filePath: string, contents: string): Promise<void> {
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

export function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonl(filePath: string, value: string | unknown): Promise<void> {
  return enqueueFileWrite(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await appendFile(filePath, `${serialized}\n`, 'utf8');
  });
}
