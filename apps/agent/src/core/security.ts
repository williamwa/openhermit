import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { internalStateFiles } from '@openhermit/shared';
import { NotFoundError, ValidationError } from '@openhermit/shared';

import type { ResolvePathOptions } from './workspace.js';
import { AgentWorkspace } from './workspace.js';
import {
  DEFAULT_SECURITY_POLICY,
  type AgentRuntimeConfig,
  type AutonomyLevel,
  type SecretsMap,
  type SecurityPolicy,
} from './types.js';

export interface AgentSecurityOptions {
  agentId: string;
  workspace: AgentWorkspace;
  openHermitHome?: string;
}

const DEFAULT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  workspace_root: '',
  model: {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    max_tokens: 8192,
  },
  http_api: {
    preferred_port: 3000,
  },
  memory: {},
};

const ensureJsonFile = async (
  filePath: string,
  defaultContent: unknown,
): Promise<void> => {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, `${JSON.stringify(defaultContent, null, 2)}\n`, 'utf8');
  }
};

const parseJsonFile = <T>(content: string, filePath: string): T => {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(
      `Invalid JSON in ${filePath}: ${message}`,
    );
  }
};

export class AgentSecurity {
  private policy: SecurityPolicy = DEFAULT_SECURITY_POLICY;

  private secrets: SecretsMap = {};

  readonly rootDir: string;

  readonly securityFilePath: string;

  readonly secretsFilePath: string;

  readonly configFilePath: string;

  readonly runtimeFilePath: string;

  readonly agentId: string;

  constructor(private readonly options: AgentSecurityOptions) {
    this.agentId = options.agentId;
    const baseDir =
      options.openHermitHome ??
      process.env.OPENHERMIT_HOME ??
      path.join(os.homedir(), '.openhermit');

    this.rootDir = path.join(baseDir, options.agentId);
    this.securityFilePath = path.join(this.rootDir, 'security.json');
    this.secretsFilePath = path.join(this.rootDir, 'secrets.json');
    this.configFilePath = path.join(this.rootDir, internalStateFiles.config);
    this.runtimeFilePath = path.join(this.rootDir, internalStateFiles.runtime);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await ensureJsonFile(this.securityFilePath, DEFAULT_SECURITY_POLICY);
    await ensureJsonFile(this.secretsFilePath, {});
    await ensureJsonFile(this.configFilePath, {
      ...DEFAULT_RUNTIME_CONFIG,
      workspace_root: this.options.workspace.root,
    });
  }

  async load(): Promise<void> {
    const [securityContent, secretsContent] = await Promise.all([
      fs.readFile(this.securityFilePath, 'utf8'),
      fs.readFile(this.secretsFilePath, 'utf8'),
    ]);

    const parsedPolicy = parseJsonFile<SecurityPolicy>(
      securityContent,
      this.securityFilePath,
    );
    const parsedSecrets = parseJsonFile<SecretsMap>(
      secretsContent,
      this.secretsFilePath,
    );

    if (
      parsedPolicy.autonomy_level !== 'readonly' &&
      parsedPolicy.autonomy_level !== 'supervised' &&
      parsedPolicy.autonomy_level !== 'full'
    ) {
      throw new ValidationError('Invalid autonomy_level in security.json');
    }

    if (!Array.isArray(parsedPolicy.require_approval_for)) {
      throw new ValidationError('Invalid require_approval_for in security.json');
    }

    this.policy = {
      autonomy_level: parsedPolicy.autonomy_level,
      require_approval_for: parsedPolicy.require_approval_for.filter(
        (value): value is string => typeof value === 'string',
      ),
    };

    const sanitizedSecrets: SecretsMap = {};

    for (const [key, value] of Object.entries(parsedSecrets)) {
      if (typeof value !== 'string') {
        throw new ValidationError(`Secret value must be a string: ${key}`);
      }

      sanitizedSecrets[key] = value;
    }

    this.secrets = sanitizedSecrets;
  }

  checkPath(relativePath: string, options?: ResolvePathOptions): Promise<string> {
    return this.options.workspace.resolve(relativePath, options);
  }

  getAutonomyLevel(): AutonomyLevel {
    return this.policy.autonomy_level;
  }

  requiresApproval(toolName: string): boolean {
    return this.policy.require_approval_for.includes(toolName);
  }

  resolveSecrets(names: string[]): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const name of names) {
      const value = this.secrets[name];

      if (value === undefined) {
        throw new NotFoundError(`Secret not found: ${name}`);
      }

      resolved[name] = value;
    }

    return resolved;
  }

  listSecretNames(): string[] {
    return Object.keys(this.secrets).sort();
  }

  async readConfig(): Promise<AgentRuntimeConfig> {
    // Reload security policy and secrets from disk on every config read,
    // so changes to security.json and secrets.json take effect without restart.
    await this.load();
    const content = await fs.readFile(this.configFilePath, 'utf8');
    const config = parseJsonFile<AgentRuntimeConfig>(content, this.configFilePath);
    return this.interpolateSecrets(config);
  }

  /**
   * Recursively replace `${{SECRET_NAME}}` placeholders in string values
   * with the corresponding secret. Unknown secret names are left as-is.
   */
  private interpolateSecrets<T>(value: T): T {
    if (typeof value === 'string') {
      return value.replace(/\$\{\{(\w+)\}\}/g, (_match, name: string) => {
        return this.secrets[name] ?? _match;
      }) as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.interpolateSecrets(item)) as T;
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.interpolateSecrets(v);
      }
      return result as T;
    }
    return value;
  }

  async writeConfig(config: AgentRuntimeConfig): Promise<void> {
    await fs.writeFile(
      this.configFilePath,
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    );
  }
}
