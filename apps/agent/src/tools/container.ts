import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

import {
  type ContainerListEntry,
  type ContainerRegistryEntry,
} from '../core/index.js';
import {
  type Toolset,
  type ToolContext,
  asTextContent,
  ensureAutonomyAllows,
  formatJson,
} from './shared.js';

const ContainerRunParams = Type.Object({
  image: Type.String({ description: 'Docker image name.' }),
  command: Type.String({ description: 'Shell command to execute.' }),
  description: Type.Optional(
    Type.String({
      description: 'Short note describing why this ephemeral container exists.',
    }),
  ),
  mount: Type.Optional(
    Type.String({
      description:
        'Optional workspace path under containers/{name}/data. If omitted, a fresh empty mount is created. Files under files/ are not mounted automatically.',
    }),
  ),
  mount_target: Type.Optional(
    Type.String({
      description:
        'Absolute in-container path where the mounted data should appear. Defaults to /workspace for ephemeral runs.',
    }),
  ),
  env_secrets: Type.Optional(
    Type.Array(
      Type.String({
        description: 'Secret names to inject as environment variables.',
      }),
    ),
  ),
  workdir: Type.Optional(
    Type.String({
      description: 'Working directory inside the container.',
    }),
  ),
});

type ContainerRunArgs = Static<typeof ContainerRunParams>;

const EmptyParams = Type.Object({});

export const createContainerRunTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerRunParams> => ({
  name: 'container_run',
  label: 'Run Container',
  description:
    'Run a one-off command in an ephemeral Docker container. The container only sees the selected mount under containers/{name}/data; if you need to run a script, write or copy it there first and pass that mount. You may also choose where that mount appears inside the container.',
  parameters: ContainerRunParams,
  execute: async (_toolCallId, args: ContainerRunArgs) => {
    ensureAutonomyAllows(security, 'container_run');

    const env =
      args.env_secrets && args.env_secrets.length > 0
        ? security.resolveSecrets(args.env_secrets)
        : undefined;

    const result = await containerManager.runEphemeral({
      image: args.image,
      command: args.command,
      ...(args.description ? { description: args.description } : {}),
      ...(args.mount ? { mount: args.mount } : {}),
      ...(args.mount_target ? { mount_target: args.mount_target } : {}),
      ...(args.workdir ? { workdir: args.workdir } : {}),
      ...(env ? { env } : {}),
    });

    const details = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.parsedOutput !== undefined
        ? { parsedOutput: result.parsedOutput }
        : {}),
      container: result.container,
    };

    return {
      content: asTextContent(formatJson(details)),
      details,
    };
  },
});

export const createContainerStatusTool = ({
  containerManager,
}: ToolContext): AgentTool<typeof EmptyParams> => ({
  name: 'container_status',
  label: 'Container Status',
  description: 'List known containers and their current status.',
  parameters: EmptyParams,
  execute: async () => {
    const containers = await containerManager.listAll();

    return {
      content: asTextContent(formatJson(containers)),
      details: {
        containers,
      },
    };
  },
});

const ContainerStartParams = Type.Object({
  name: Type.String({
    description:
      'Unique name for the service container. Used to reference it in stop/exec calls.',
  }),
  image: Type.String({ description: 'Docker image name.' }),
  description: Type.Optional(
    Type.String({
      description: 'Short note describing the purpose of this service.',
    }),
  ),
  mount: Type.Optional(
    Type.String({
      description:
        'Workspace path under containers/{name}/data to mount into the container. Defaults to containers/{name}/data.',
    }),
  ),
  mount_target: Type.Optional(
    Type.String({
      description:
        'Absolute in-container path for the mounted data. Defaults to /data. Use this when a service expects files at a specific location such as /usr/share/nginx/html.',
    }),
  ),
  ports: Type.Optional(
    Type.Record(
      Type.String({ description: 'Container port (e.g. "5432").' }),
      Type.Number({ description: 'Host port to bind (e.g. 10001).' }),
      {
        description:
          'Port mappings: { "<containerPort>": <hostPort> }. Warn the user to run "tailscale funnel <hostPort>" themselves if external access is needed.',
      },
    ),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Plain environment variables to pass to the container.',
    }),
  ),
  env_secrets: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Secret names whose values are resolved at launch and injected as env vars. Values are never returned to the agent.',
    }),
  ),
  network: Type.Optional(
    Type.String({
      description:
        'Docker network name. Containers on the same network can reach each other by container name.',
    }),
  ),
});

type ContainerStartArgs = Static<typeof ContainerStartParams>;

export const createContainerStartTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerStartParams> => ({
  name: 'container_start',
  label: 'Start Service Container',
  description:
    'Start a long-running service container (e.g. Postgres, Redis). The container is registered and persists across agent restarts until explicitly stopped. Port bindings expose the service on the host; inform the user if external access requires additional host configuration.',
  parameters: ContainerStartParams,
  execute: async (_toolCallId, args: ContainerStartArgs) => {
    ensureAutonomyAllows(security, 'container_start');

    const secretEnv =
      args.env_secrets && args.env_secrets.length > 0
        ? security.resolveSecrets(args.env_secrets)
        : {};

    const env =
      Object.keys(secretEnv).length > 0 || (args.env && Object.keys(args.env).length > 0)
        ? { ...(args.env ?? {}), ...secretEnv }
        : undefined;

    const entry = await containerManager.startService({
      name: args.name,
      image: args.image,
      ...(args.description ? { description: args.description } : {}),
      ...(args.mount ? { mount: args.mount } : {}),
      ...(args.mount_target ? { mount_target: args.mount_target } : {}),
      ...(args.ports ? { ports: args.ports } : {}),
      ...(env ? { env } : {}),
      ...(args.network ? { network: args.network } : {}),
    });

    const portHints =
      entry.ports && Object.keys(entry.ports).length > 0
        ? `\nBound ports: ${Object.entries(entry.ports)
            .map(([containerPort, hostPort]) => `${containerPort} → host:${hostPort}`)
            .join(', ')}. Run "tailscale funnel <hostPort>" on the host if external access is needed.`
        : '';

    return {
      content: asTextContent(`Service "${entry.name}" started.${portHints}`),
      details: entry,
    };
  },
});

const ContainerStopParams = Type.Object({
  name: Type.String({ description: 'Name of the service container to stop and remove.' }),
});

type ContainerStopArgs = Static<typeof ContainerStopParams>;

export const createContainerStopTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerStopParams> => ({
  name: 'container_stop',
  label: 'Stop Service Container',
  description: 'Stop a running service container. The container is preserved and can be restarted with container_start.',
  parameters: ContainerStopParams,
  execute: async (_toolCallId, args: ContainerStopArgs) => {
    ensureAutonomyAllows(security, 'container_stop');

    const entry = await containerManager.stopService(args.name);

    return {
      content: asTextContent(`Service "${entry.name}" stopped.`),
      details: entry,
    };
  },
});

const ContainerExecParams = Type.Object({
  name: Type.String({ description: 'Name of the running service container.' }),
  command: Type.String({ description: 'Shell command to execute inside the container.' }),
});

type ContainerExecArgs = Static<typeof ContainerExecParams>;

export const createContainerExecTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerExecParams> => ({
  name: 'container_exec',
  label: 'Exec in Service Container',
  description:
    'Execute a shell command inside a running service container and return stdout/stderr. Use this to inspect state, run migrations, or interact with a service.',
  parameters: ContainerExecParams,
  execute: async (_toolCallId, args: ContainerExecArgs) => {
    ensureAutonomyAllows(security, 'container_exec');

    const result = await containerManager.execInService(args.name, args.command);

    const details = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.parsedOutput !== undefined ? { parsedOutput: result.parsedOutput } : {}),
    };

    return {
      content: asTextContent(formatJson(details)),
      details,
    };
  },
});

export const summarizeContainerList = (
  containers: ContainerListEntry[],
): string => formatJson(containers);

export const summarizeContainerEntry = (
  container: ContainerRegistryEntry,
): string => formatJson(container);

// ── Toolset ────────────────────────────────────────────────────────

const CONTAINER_DESCRIPTION = `\
### Containers

#### Service Containers

For long-running background services (databases, caches, web servers):
- \`container_start\` to launch a named service (e.g. postgres, redis, nginx)
- \`container_exec\` to run commands inside a running service
- \`container_stop\` to stop a service (preserved for restart)
- \`container_status\` to list all containers and their state

Service containers persist across agent restarts until explicitly stopped.

##### Mounting files into service containers

Each service container gets a dedicated data directory at \`containers/<name>/data\` in the workspace. This is the **only** path you may mount. The workspace root or other arbitrary paths cannot be mounted.

When starting a service, the \`mount\` field defaults to \`containers/<name>/data\` and \`mount_target\` defaults to \`/data\` inside the container. You **must** set \`mount_target\` to the path the service actually expects its files at.

**Example — nginx serving a static site:**

1. Prepare files:
   \`\`\`
   mkdir -p /workspace/containers/web/data
   echo '<h1>Hello</h1>' > /workspace/containers/web/data/index.html
   \`\`\`
2. Start the service with the correct \`mount_target\`:
   \`\`\`json
   {
     "name": "web",
     "image": "nginx:alpine",
     "ports": {"80": 8080},
     "mount_target": "/usr/share/nginx/html"
   }
   \`\`\`
   This mounts \`containers/web/data\` → \`/usr/share/nginx/html\` so nginx finds the files.

**Common mount_target values:**
- nginx static files: \`/usr/share/nginx/html\`
- postgres data: \`/var/lib/postgresql/data\`
- generic data: \`/data\` (the default)

If you omit \`mount_target\`, files end up at \`/data\` and the service likely won't find them. Always check what path the service image expects.

#### Ephemeral Containers (\`container_run\`)

One-off, disposable containers for isolated tasks. Use them only when you need a specific image or clean-room environment that differs from the workspace.

Ephemeral containers are automatically removed after execution.`;

export const createContainerToolset = (context: ToolContext): Toolset => ({
  id: 'container',
  description: CONTAINER_DESCRIPTION,
  tools: [
    createContainerRunTool(context),
    createContainerStatusTool(context),
    createContainerStartTool(context),
    createContainerStopTool(context),
    createContainerExecTool(context),
  ],
});
