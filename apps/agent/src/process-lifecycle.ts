import { rmSync } from 'node:fs';

import type { ServerType } from '@hono/node-server';

const closeServer = async (server: ServerType): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

export const createBeforeExitLangfuseHandler = (
  shutdownLangfuse: (() => Promise<void>) | undefined,
) => (): void => {
  if (!shutdownLangfuse) {
    return;
  }

  void shutdownLangfuse();
};

export const createSignalShutdownHandler = (input: {
  server: ServerType;
  shutdownLangfuse?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  exit?: (code: number) => never | void;
  logger?: (message: string) => void;
}) => {
  let shutdownPromise: Promise<void> | undefined;

  return (): void => {
    if (shutdownPromise) {
      return;
    }

    shutdownPromise = (async () => {
      try {
        await input.shutdownLangfuse?.();
      } catch (error) {
        input.logger?.(
          `graceful shutdown: Langfuse flush failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      try {
        await closeServer(input.server);
      } catch (error) {
        input.logger?.(
          `graceful shutdown: server close failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      try {
        await input.cleanup?.();
      } catch (error) {
        input.logger?.(
          `graceful shutdown: cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      (input.exit ?? process.exit)(0);
    })();
  };
};

export const createExitRuntimeFileCleanupHandler = (
  runtimeFilePath: string,
  logger?: (message: string) => void,
) => (): void => {
  try {
    rmSync(runtimeFilePath, { force: true });
  } catch (error) {
    logger?.(
      `exit cleanup: failed to remove runtime metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};
