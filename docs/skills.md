# Skills System

Skills are structured instructions that extend an agent's capabilities. Unlike tools (which are code-level primitives), skills are **prompt-based recipes** — they tell the agent *what to do* and optionally provide supporting files (scripts, templates, references) for the agent to execute within its sandbox.

## Design Principles

- **Skills are instructions, not code plugins.** The agent already has a sandbox with `exec` — it can run any command, write any code. A skill just tells it how.
- **Database-driven management.** Skill metadata and assignments live in PostgreSQL, consistent with OpenHermit's centralized state model. No scattered config files.
- **File-based content.** Skill directories (SKILL.md + supporting files) live on the filesystem and are mounted into workspace containers. The database indexes them; the filesystem stores them.
- **Three-tier scoping.** Platform-wide, per-agent, and agent-self-installed skills coexist with clear precedence and security boundaries.

## Skill Format

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```yaml
---
name: deploy-staging
description: Build, test, and deploy the current project to staging environment
roles: [owner, user]        # Which user roles can invoke this skill (default: all)
---

## Steps

1. Run `ls /skills/deploy-staging/scripts/` to see available deployment scripts
2. Run the test suite: `exec` with `npm test`
3. If tests pass, run `/skills/deploy-staging/scripts/deploy.sh`
4. Report the deployment URL
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier. Lowercase, hyphens, max 64 chars |
| `description` | Yes | One-line summary (max 256 chars). Loaded into system prompt index |
| `roles` | No | User roles that can invoke this skill. Default: all roles |

### Supporting Files

A skill directory may contain any additional files the agent needs:

```
deploy-staging/
  SKILL.md
  scripts/deploy.sh
  templates/nginx.conf
  references/runbook.md
```

These files are accessible to the agent at the mount path (see Storage Layout below).

## Storage Layout

### Host Filesystem

```
~/.openhermit/skills/                  # Platform-level skill directories
  deploy-staging/
    SKILL.md
    scripts/deploy.sh
  search-github/
    SKILL.md
```

### Workspace Container

```
/skills/                                # Read-only mount of enabled system/owner skills
  deploy-staging/
    SKILL.md
    scripts/deploy.sh
  search-github/
    SKILL.md

/workspace/.openhermit/skills/          # Agent-installed skills (read-write)
  my-custom-workflow/
    SKILL.md
    scripts/helper.py
```

Load precedence (highest first): `/skills/` > `/workspace/.openhermit/skills/`. A system skill cannot be overridden by an agent-installed skill with the same name.

## Database Schema

### `skills` Table

Stores all registered skill definitions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Skill identifier (matches directory name) |
| `name` | TEXT | Display name |
| `description` | TEXT | One-line summary for system prompt index |
| `path` | TEXT | Host filesystem path to skill directory |
| `metadata_json` | TEXT | JSON blob for tags, version, author, etc. |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp |

### `agent_skills` Table

Tracks which skills are enabled for which agents.

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | TEXT | Agent ID, or `*` for all agents |
| `skill_id` | TEXT FK → skills.id | Skill reference |
| `enabled` | BOOLEAN | Whether the skill is active |
| `created_at` | TEXT | ISO 8601 timestamp |
| **PK** | | `(agent_id, skill_id)` |

## Three Tiers

### 1. Platform Skills (admin-managed)

- Stored at `~/.openhermit/skills/<id>/`
- Registered via gateway admin API
- Enabled globally with `agent_id = '*'` in `agent_skills`
- Mounted read-only at `/skills/<id>/` in all workspace containers
- The agent cannot modify these

### 2. Per-Agent Skills (owner-managed)

- Stored at `~/.openhermit/skills/<id>/` (same pool as platform skills)
- Enabled for a specific agent via `agent_skills` with a concrete `agent_id`
- Owner manages through API or conversation (`skill enable/disable`)
- Mounted read-only at `/skills/<id>/`

### 3. Agent-Installed Skills (agent-managed)

- Stored at `/workspace/.openhermit/skills/<id>/` inside the workspace volume
- Agent installs via `exec` (e.g. `curl`, `git clone`): downloads from URL, writes files to workspace
- **Not stored in database** — the workspace filesystem is the source of truth. At startup, the agent runtime scans this directory and reads SKILL.md frontmatter to build the index
- Read-write — the agent can create, update, and delete these
- Persists across sessions (part of workspace volume)

## Runtime Integration

### System Prompt

At agent startup, all enabled skills (name + description only) are loaded into the system prompt as an index:

```
## Skills

The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its SKILL.md for detailed instructions.

- **deploy-staging**: Build, test, and deploy the current project to staging environment — `cat /skills/deploy-staging/SKILL.md`
- **search-github**: Search GitHub repositories and issues by keyword — `cat /skills/search-github/SKILL.md`
```

Full skill content (SKILL.md body) is loaded only when the agent reads it via `cat`, to conserve context window.

### Agent Interaction

No dedicated skill tools are needed. The agent interacts with skills using existing capabilities:

- **Discovery**: Enabled skills (name + description) are listed in the system prompt automatically at startup
- **Reading**: The agent reads a skill's full content via `exec cat /skills/<id>/SKILL.md` (or `/workspace/.openhermit/skills/<id>/SKILL.md` for workspace skills)
- **Execution**: The agent follows the skill's instructions using its standard tools (`exec`, `web_fetch`, etc.)
- **Self-install**: The agent can download skills into its workspace via `exec` (e.g. `curl`, `wget`, `git clone`)
- **Self-uninstall**: The agent can remove workspace skills via `exec rm -rf`

### Container Mount Flow

When a workspace container starts:

1. Query `agent_skills` for all enabled skills for this agent (including `agent_id = '*'`)
2. Resolve each skill's host `path` from the `skills` table
3. Mount each skill directory read-only into the container at `/skills/<id>/`
4. `/workspace/.openhermit/skills/` is already part of the workspace volume — no extra mount needed

### Skill Index Loading

At agent startup, the runtime merges skills from all three tiers:

1. **Database skills**: Query enabled skills → read `/skills/<id>/SKILL.md` for content
2. **Workspace skills**: Scan `/workspace/.openhermit/skills/*/SKILL.md`, parse frontmatter
3. **Dedup**: `/skills/` takes precedence — if a system skill and workspace skill share the same name, the system skill wins

## API Endpoints

### Admin (gateway-level)

```
POST   /admin/skills              # Register a new skill
GET    /admin/skills              # List all skills in the library
GET    /admin/skills/:id          # Get skill details
DELETE /admin/skills/:id          # Remove a skill
POST   /admin/skills/:id/enable   # Enable for agent(s): { agentId: "*" | "<id>" }
POST   /admin/skills/:id/disable  # Disable for agent(s)
```

### Agent (per-agent API)

```
GET    /agents/:agentId/skills          # List effective skills (merged, real-time)
POST   /agents/:agentId/skills/:id/enable
POST   /agents/:agentId/skills/:id/disable
```

The `GET /agents/:agentId/skills` endpoint returns the **actual effective skill list** by merging two sources in real-time:

1. Database: query enabled system/owner skills for this agent
2. Workspace: scan `/workspace/.openhermit/skills/*/SKILL.md` and parse frontmatter

Each entry includes a `source` field (`system` | `workspace`) indicating where the skill comes from. Dedup applies — system skills take precedence over workspace skills with the same name.

This is the same logic used internally by the `skill_list` tool.
