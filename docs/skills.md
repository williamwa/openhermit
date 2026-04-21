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
| `source` | TEXT | `platform` \| `agent` — who installed it |
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
- Agent installs via `skill_install` tool: downloads from URL, writes files, registers metadata in database with `source = 'agent'`
- Read-write — the agent can create, update, and delete these
- Persists across sessions (part of workspace volume)

## Runtime Integration

### System Prompt

At agent startup, all enabled skills (name + description only) are loaded into the system prompt as an index:

```
## Skills

Available skills — use `skill_invoke` to activate one:

- **deploy-staging**: Build, test, and deploy the current project to staging environment
- **search-github**: Search GitHub repositories and issues by keyword
- **my-custom-workflow**: Custom data pipeline for weekly reports
```

Full skill content (SKILL.md body) is loaded only when the skill is invoked, to conserve context window.

### Tools

| Tool | Description |
|------|-------------|
| `skill_list` | List all enabled skills with descriptions |
| `skill_invoke` | Load a skill's full content into context and follow its instructions |
| `skill_install` | Download a skill from a URL and install to workspace skills |
| `skill_uninstall` | Remove an agent-installed skill |

### Container Mount Flow

When a workspace container starts:

1. Query `agent_skills` for all enabled skills for this agent (including `agent_id = '*'`)
2. Resolve each skill's host `path` from the `skills` table
3. Mount each skill directory read-only into the container at `/skills/<id>/`
4. `/workspace/.openhermit/skills/` is already part of the workspace volume — no extra mount needed

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
GET    /agents/:agentId/skills          # List enabled skills for this agent
POST   /agents/:agentId/skills/:id/enable
POST   /agents/:agentId/skills/:id/disable
```
