import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import type { ProcessResult, ProcessRunOptions } from './types.ts';

interface ProcessTimeoutDetails {
  command: string;
  args: string[];
  timeoutMs: number;
  stdout: string;
  stderr: string;
  signal: string | null;
  durationMs: number;
}

export class ProcessTimeoutError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly timeoutMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: string | null;
  readonly durationMs: number;

  constructor(details: ProcessTimeoutDetails) {
    super(`Process timed out after ${details.timeoutMs}ms: ${details.command}`);
    this.name = 'ProcessTimeoutError';
    this.command = details.command;
    this.args = [...details.args];
    this.timeoutMs = details.timeoutMs;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.signal = details.signal;
    this.durationMs = details.durationMs;
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let hardKillHandle: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (hardKillHandle) {
        clearTimeout(hardKillHandle);
      }
    };

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('close', (exitCode, signal) => {
      cleanup();

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));

      if (timedOut && options.timeoutMs) {
        reject(
          new ProcessTimeoutError({
            command,
            args,
            timeoutMs: options.timeoutMs,
            stdout,
            stderr,
            signal,
            durationMs,
          }),
        );
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        signal,
        durationMs,
      });
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;

        void Promise.resolve(options.onTimeout?.()).catch(() => {});
        child.kill('SIGTERM');

        hardKillHandle = setTimeout(() => {
          child.kill('SIGKILL');
        }, 250);
        hardKillHandle.unref();
      }, options.timeoutMs);
      timeoutHandle.unref();
    }
  });
}
