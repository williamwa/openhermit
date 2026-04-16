import type { PrismaClient } from '../generated/prisma/index.js';
import { NotFoundError } from '@openhermit/shared';

import type { ContainerStore } from '../interfaces.js';
import type {
  ContainerRegistryEntry,
  ContainerStatus,
  ContainerType,
  StoreScope,
} from '../types.js';

export class DbContainerStore implements ContainerStore {
  constructor(private readonly prisma: PrismaClient) {}

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

  private mapRow(row: {
    containerName: string;
    containerType: string;
    image: string;
    status: string;
    description: string | null;
    metadataJson: string;
  }): ContainerRegistryEntry {
    const metadata = JSON.parse(row.metadataJson || '{}') as Record<string, unknown>;

    return {
      id:
        typeof metadata.id === 'string'
          ? metadata.id
          : row.containerName,
      name: row.containerName,
      image: row.image,
      type: row.containerType as ContainerType,
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
    const rows = await this.prisma.container.findMany({
      where: { agentId: scope.agentId },
    });

    // Sort by created timestamp extracted from metadata, then by name
    const entries = rows.map((row) => this.mapRow(row));
    entries.sort((a, b) => {
      const cmp = a.created.localeCompare(b.created);
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
    });
    return entries;
  }

  async findByName(scope: StoreScope, name: string): Promise<ContainerRegistryEntry | undefined> {
    const row = await this.prisma.container.findUnique({
      where: { agentId_containerName: { agentId: scope.agentId, containerName: name } },
    });

    if (!row) return undefined;
    return this.mapRow(row);
  }

  async upsert(scope: StoreScope, entry: ContainerRegistryEntry): Promise<void> {
    const data = {
      containerType: entry.type,
      image: entry.image,
      status: entry.status,
      description: entry.description ?? null,
      metadataJson: this.serializeMetadata(entry),
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.container.upsert({
      where: { agentId_containerName: { agentId: scope.agentId, containerName: entry.name } },
      create: {
        agentId: scope.agentId,
        containerName: entry.name,
        ...data,
      },
      update: data,
    });
  }

  async updateByName(
    scope: StoreScope,
    name: string,
    update: (entry: ContainerRegistryEntry) => ContainerRegistryEntry,
  ): Promise<ContainerRegistryEntry> {
    const currentEntry = await this.findByName(scope, name);

    if (!currentEntry) {
      throw new NotFoundError(`Container not found in registry: ${name}`);
    }

    const updated = update(currentEntry);
    await this.upsert(scope, updated);
    return updated;
  }
}
