import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { runProcess, ProcessTimeoutError } from './process.ts';
import { readConfig, resolveReadPath } from './workspace.ts';

import type {
  ContainerRunOptions,
  ContainerRunPlan,
  ContainerRunResult,
  ProcessRunner,
  WorkspaceConfig,
} from './types.ts';

interface ContainerRunnerDependencies {
  runProcess?: ProcessRunner;
  forceRemoveContainer?: (containerName: string) => Promise<void>;
}

function isWithinPath(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true;
  }

  const normalizedRoot = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return candidatePath.startsWith(normalizedRoot);
}

function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

function assertAllowedImage(config: WorkspaceConfig, image: string): void {
  if (!config.container_defaults.image_allowlist.includes(image)) {
    throw new Error(`Image is not in the allowlist: ${image}`);
  }
}

function normalizeEnvironment(env: ContainerRunOptions['env']): Record<string, string> {
  if (!env) {
    return {};
  }

  const normalizedEnv: Record<string, string> = {};

  for (const [name, value] of Object.entries(env)) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('Environment variable names must be non-empty strings');
    }

    if (typeof value !== 'string') {
      throw new Error(`Environment variable "${name}" must be a string`);
    }

    normalizedEnv[name] = value;
  }

  return normalizedEnv;
}

async function resolveContainerWorkdir(
  workspaceRoot: string,
  workdir?: string,
): Promise<{ hostWorkdirPath: string; containerWorkdir: string }> {
  const filesRoot = await resolveReadPath(workspaceRoot, 'files');

  if (workdir === undefined || workdir === '.' || workdir.length === 0) {
    return {
      hostWorkdirPath: filesRoot,
      containerWorkdir: '/workspace',
    };
  }

  if (workdir.includes('\0')) {
    throw new Error('Container workdir cannot contain null bytes');
  }

  if (isAbsolute(workdir)) {
    throw new Error('Container workdir must be relative to files/');
  }

  const candidatePath = resolve(filesRoot, workdir);
  if (!isWithinPath(filesRoot, candidatePath)) {
    throw new Error(`Container workdir escapes files/: ${workdir}`);
  }

  const hostWorkdirPath = await resolveReadPath(workspaceRoot, `files/${workdir}`);
  if (!isWithinPath(filesRoot, hostWorkdirPath)) {
    throw new Error(`Container workdir escapes files/ after symlink resolution: ${workdir}`);
  }

  const relativeWorkdir = toPosixPath(relative(filesRoot, hostWorkdirPath));
  return {
    hostWorkdirPath,
    containerWorkdir: relativeWorkdir.length === 0 ? '/workspace' : `/workspace/${relativeWorkdir}`,
  };
}

function validateRunOptions(options: ContainerRunOptions): void {
  if (typeof options.image !== 'string' || options.image.length === 0) {
    throw new Error('Container image must be a non-empty string');
  }

  if (typeof options.command !== 'string' || options.command.length === 0) {
    throw new Error('Container command must be a non-empty string');
  }
}

export async function createContainerRunPlan(
  workspaceRoot: string,
  options: ContainerRunOptions,
): Promise<ContainerRunPlan> {
  validateRunOptions(options);

  const config = await readConfig(workspaceRoot);
  assertAllowedImage(config, options.image);

  const hostFilesPath = await resolveReadPath(workspaceRoot, 'files');
  const { containerWorkdir } = await resolveContainerWorkdir(workspaceRoot, options.workdir);
  const env = normalizeEnvironment(options.env);
  const containerName = `cloudmind-run-${randomUUID().slice(0, 12)}`;

  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--memory',
    config.container_defaults.memory_limit,
    '--cpu-shares',
    String(config.container_defaults.cpu_shares),
    '--network',
    config.container_defaults.network === 'disabled' ? 'none' : config.container_defaults.network,
    '--volume',
    `${hostFilesPath}:/workspace`,
    '--workdir',
    containerWorkdir,
    ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    options.image,
    'sh',
    '-lc',
    options.command,
  ];

  return {
    image: options.image,
    command: options.command,
    containerName,
    hostFilesPath,
    containerWorkdir,
    env,
    timeoutMs: config.container_defaults.timeout_seconds * 1000,
    args,
  };
}

export async function forceRemoveContainer(
  containerName: string,
  processRunner: ProcessRunner = runProcess,
): Promise<void> {
  try {
    await processRunner('docker', ['rm', '--force', containerName], { timeoutMs: 5_000 });
  } catch {
    // Best-effort cleanup. Timeouts or missing containers are handled by the main run path.
  }
}

export class ContainerRunTimeoutError extends Error {
  readonly plan: ContainerRunPlan;
  readonly timeoutMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: string | null;
  readonly durationMs: number;

  constructor(plan: ContainerRunPlan, error: ProcessTimeoutError) {
    super(`Container run timed out after ${error.timeoutMs}ms: ${plan.image}`);
    this.name = 'ContainerRunTimeoutError';
    this.plan = plan;
    this.timeoutMs = error.timeoutMs;
    this.stdout = error.stdout;
    this.stderr = error.stderr;
    this.signal = error.signal;
    this.durationMs = error.durationMs;
  }
}

export async function runEphemeralContainer(
  workspaceRoot: string,
  options: ContainerRunOptions,
  dependencies: ContainerRunnerDependencies = {},
): Promise<ContainerRunResult> {
  const plan = await createContainerRunPlan(workspaceRoot, options);
  const processRunner = dependencies.runProcess ?? runProcess;
  const removeContainer = dependencies.forceRemoveContainer
    ?? ((containerName: string) => forceRemoveContainer(containerName, processRunner));

  try {
    const result = await processRunner('docker', plan.args, {
      timeoutMs: plan.timeoutMs,
      onTimeout: () => removeContainer(plan.containerName),
    });

    return {
      ...result,
      image: plan.image,
      command: plan.command,
      containerName: plan.containerName,
      hostFilesPath: plan.hostFilesPath,
      containerWorkdir: plan.containerWorkdir,
    };
  } catch (error) {
    if (error instanceof ProcessTimeoutError) {
      throw new ContainerRunTimeoutError(plan, error);
    }

    throw error;
  }
}
