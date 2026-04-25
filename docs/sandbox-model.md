# Sandbox Model

OpenHermit's executable workspace is mediated by exec backends. The default gateway-created agent uses a Docker workspace backend; a local shell backend also exists for development or explicitly trusted setups.

## Exec Backend Config

```json
{
  "exec": {
    "backends": [
      {
        "id": "docker",
        "type": "docker",
        "image": "ubuntu:24.04"
      }
    ],
    "default_backend": "docker",
    "lifecycle": {
      "start": "ondemand",
      "stop": "idle",
      "idle_timeout_minutes": 30
    }
  }
}
```

Supported backend types:

- `docker`
- `local`

If no exec config is present, the runner falls back to a local backend.

## Docker Backend

The Docker backend uses `DockerContainerManager` to ensure a per-agent workspace container. The workspace directory is mounted at `/workspace`. Enabled DB-managed skills are mounted read-only at `/skills` when skill mounts are available.

Container inventory is internal state in the `containers` table. Mounted workspace files remain external task state.

## Local Backend

The local backend runs `shell -lc` commands on the host. It supports:

- `cwd`
- `shell`
- `env`
- `timeout_ms`

Use it only in trusted environments because it intentionally bypasses container isolation.

## Lifecycle

Start policy:

- `ondemand`: start/ensure backend when a tool call needs it
- `session`: ensure backend when a session opens

Stop policy:

- `idle`: stop after idle timeout
- `session`: stop when the session ends/shuts down

## Security Policy

`security.json` controls model autonomy and approval gating:

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["exec"]
}
```

The sandbox limits where commands run; approval policy limits when commands run.
