import { constants as fsConstants, promises as fs } from 'node:fs';

type RuntimeMetadata = {
  http_api?: {
    port?: unknown;
    token?: unknown;
  };
};

const parseRuntimeMetadataPort = (content: string): number | undefined => {
  try {
    const parsed = JSON.parse(content) as RuntimeMetadata;
    const port = parsed.http_api?.port;

    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
      return undefined;
    }

    return port;
  } catch {
    return undefined;
  }
};

const defaultProbe = async (port: number): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
    });

    return response.ok;
  } catch {
    return false;
  }
};

export const assertRuntimeMetadataAbsent = async (
  runtimeFilePath: string,
  options: {
    probe?: (port: number) => Promise<boolean>;
  } = {},
): Promise<void> => {
  try {
    await fs.access(runtimeFilePath, fsConstants.F_OK);
  } catch {
    return;
  }

  const content = await fs.readFile(runtimeFilePath, 'utf8').catch(() => '');
  const port = parseRuntimeMetadataPort(content);

  if (port !== undefined) {
    const isReachable = await (options.probe ?? defaultProbe)(port);

    if (isReachable) {
      throw new Error(
        `Refusing to start: another agent appears to be running at http://127.0.0.1:${port}. `
        + `Runtime metadata already exists at ${runtimeFilePath}. Stop the running agent first.`,
      );
    }

    throw new Error(
      `Refusing to start: stale runtime metadata exists at ${runtimeFilePath} `
      + `and points to http://127.0.0.1:${port}, but no agent responded there. `
      + 'Remove that runtime.json and retry.',
    );
  }

  throw new Error(
    `Refusing to start: runtime metadata already exists at ${runtimeFilePath}, `
    + 'but it could not be parsed. Remove that runtime.json and retry.',
  );
};
