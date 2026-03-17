import { constants as fsConstants, promises as fs } from 'node:fs';

export const assertRuntimeMetadataAbsent = async (
  runtimeFilePath: string,
): Promise<void> => {
  try {
    await fs.access(runtimeFilePath, fsConstants.F_OK);
  } catch {
    return;
  }

  throw new Error(
    `Refusing to start: runtime metadata already exists at ${runtimeFilePath}. `
    + 'This usually means another agent process is still active or the last one did not shut down cleanly.',
  );
};
