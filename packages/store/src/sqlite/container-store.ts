import type { DatabaseSync } from 'node:sqlite';
import { NotFoundError } from '@openhermit/shared';

import type { ContainerStore } from '../interfaces.js';
import type {
  ContainerRegistryEntry,
  ContainerStatus,
  ContainerType,
  StoreScope,
} from '../types.js';

export class SqliteContainerStore implements ContainerStore {
  constructor(private readonly database: DatabaseSync) {}

  private serializeMetadata(entry: ContainerRegistryEntry): string {
    return JSON.stringify({
      id: entry.id,
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.ports !== undefined ? { ports: entry.ports } : {}),
      ...(entry.mount !== undefined ? { mount: entry.mount } : {}),
      ...(entry.mount_target !== undefined ? { mount_target: entry.mount_target } : {}),
      ...(entry.network !== undefined ? { network: entry.network } : {}),
      ...(entry.runtime_container_id !== undefined
        ? { runtime_container_id: entry.runtime_container_id }
        : {}),
      ...(entry.exit_code !== undefined ? { exit_code: entry.exit_code } : {}),
      created: entry.created,
      ...(entry.removed !== undefined ? { removed: entry.removed } : {}),
    });
  }

  private mapRow(
    row: {
      container_name: string;
      container_type: string;
      image: string;
      status: string;
      description: string | null;
      metadata_json: string;
    },
  ): ContainerRegistryEntry {
    const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;

    return {
      id:
        typeof metadata.id === 'string'
          ? metadata.id
          : row.container_name,
      name: row.container_name,
      image: row.image,
      type: row.container_type as ContainerType,
      status: row.status as ContainerStatus,
      ...(row.description ? { description: row.description } : {}),
      ...(typeof metadata.command === 'string' ? { command: metadata.command } : {}),
      ...(metadata.ports && typeof metadata.ports === 'object'
        ? { ports: metadata.ports as Record<string, number> }
        : {}),
      ...(typeof metadata.mount === 'string' ? { mount: metadata.mount } : {}),
      ...(typeof metadata.mount_target === 'string'
        ? { mount_target: metadata.mount_target }
        : {}),
      ...(typeof metadata.network === 'string' ? { network: metadata.network } : {}),
      ...(typeof metadata.runtime_container_id === 'string'
        ? { runtime_container_id: metadata.runtime_container_id }
        : {}),
      ...(typeof metadata.exit_code === 'number' ? { exit_code: metadata.exit_code } : {}),
      created:
        typeof metadata.created === 'string'
          ? metadata.created
          : new Date().toISOString(),
      ...(typeof metadata.removed === 'string' ? { removed: metadata.removed } : {}),
    };
  }

  async readAll(scope: StoreScope): Promise<ContainerRegistryEntry[]> {
    const rows = this.database
      .prepare(
        `SELECT container_name, container_type, image, status, description, metadata_json
         FROM container_runtime_entries
         WHERE agent_id = ?
         ORDER BY json_extract(metadata_json, '$.created') ASC, container_name ASC`,
      )
      .all(scope.agentId) as Array<{
      container_name: string;
      container_type: string;
      image: string;
      status: string;
      description: string | null;
      metadata_json: string;
    }>;

    return rows.map((row) => this.mapRow(row));
  }

  async findByName(scope: StoreScope, name: string): Promise<ContainerRegistryEntry | undefined> {
    const entries = await this.readAll(scope);
    return entries.find((entry) => entry.name === name);
  }

  async upsert(scope: StoreScope, entry: ContainerRegistryEntry): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO container_runtime_entries(
          agent_id,
          container_name,
          container_type,
          image,
          status,
          description,
          metadata_json,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, container_name) DO UPDATE SET
          container_type = excluded.container_type,
          image = excluded.image,
          status = excluded.status,
          description = excluded.description,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        scope.agentId,
        entry.name,
        entry.type,
        entry.image,
        entry.status,
        entry.description ?? null,
        this.serializeMetadata(entry),
        new Date().toISOString(),
      );
  }

  async updateByName(
    scope: StoreScope,
    name: string,
    update: (entry: ContainerRegistryEntry) => ContainerRegistryEntry,
  ): Promise<ContainerRegistryEntry> {
    const entries = await this.readAll(scope);
    const currentEntry = entries.find((entry) => entry.name === name);

    if (!currentEntry) {
      throw new NotFoundError(`Container not found in registry: ${name}`);
    }

    const updated = update(currentEntry);
    await this.upsert(scope, updated);
    return updated;
  }
}
