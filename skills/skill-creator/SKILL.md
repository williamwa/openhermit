---
name: skill-creator
description: Create, structure, and validate new skills. Use when designing a skill, scaffolding a skill directory, or improving an existing skill.
---

# Skill Creator

You are creating or updating an OpenHermit skill. A skill is a directory containing a `SKILL.md` file (with YAML frontmatter) and optional supporting files (scripts, references, templates). Skills are prompt-based instructions — they tell you *what to do*, not code plugins.

## Skill Format

```
<skill-id>/
  SKILL.md          # Required — frontmatter + instructions
  scripts/          # Optional — deterministic code the agent runs
  references/       # Optional — documentation loaded on demand
  templates/        # Optional — output templates, config files
```

### SKILL.md Structure

```markdown
---
name: <lowercase-hyphen-case, max 64 chars>
description: <one-line summary, max 256 chars — this appears in the system prompt index>
---

<body: detailed instructions for the agent>
```

**Frontmatter rules:**
- `name` — required. Lowercase, hyphens only (`[a-z0-9-]+`), no leading/trailing/consecutive hyphens, max 64 chars.
- `description` — required. One clear sentence. This is the *only* thing shown in the system prompt, so it must be specific enough to trigger skill activation. Max 256 chars.

## Process

### 1. Clarify the skill's purpose

Ask the user:
- What task does this skill handle?
- When should it activate? (What kind of user request triggers it?)
- What does success look like?

Generate 2-3 concrete usage examples to confirm understanding.

### 2. Plan the skill contents

For each example, identify what reusable resources are needed:

| Directory | When to use | Loaded into context? |
|-----------|------------|---------------------|
| `scripts/` | Deterministic operations that must be exact (deploy, validate, transform) | No — executed via `exec` |
| `references/` | Documentation the agent reads on demand (`cat references/api-spec.md`) | On demand only |
| `templates/` | Output files, config templates, boilerplate | No — copied/rendered via `exec` |

**Keep SKILL.md under 500 lines.** If longer, split into reference files.

### 3. Write the skill

Create the directory and files. Key principles:

- **Be specific.** Vague instructions produce vague results. If there's a specific command, write the exact command.
- **Be concise.** The context window is a shared resource. Only include what the agent doesn't already know.
- **Use imperative voice.** "Run the tests" not "You should run the tests".
- **Progressive disclosure.** Put the trigger description in frontmatter (always loaded), core instructions in SKILL.md body (loaded when activated), details in reference files (loaded on demand).
- **No fluff files.** No README.md, CHANGELOG.md, or LICENSE unless the skill specifically needs them.

### 4. Validate

Check the skill against these rules:
- [ ] `SKILL.md` exists with valid YAML frontmatter
- [ ] `name` is lowercase hyphen-case, max 64 chars
- [ ] `description` is one sentence, max 256 chars, specific enough to trigger activation
- [ ] Body provides clear, actionable instructions
- [ ] No unnecessary files

### 5. Install the skill

**As a workspace skill (self-install):**
```bash
# Write files to /workspace/.openhermit/skills/<skill-id>/
mkdir -p /workspace/.openhermit/skills/<skill-id>
# Write SKILL.md and supporting files
```

**As a platform skill (admin-managed):**
The admin registers it via the gateway API and places files at `~/.openhermit/skills/<skill-id>/`.

## Examples of Good Descriptions

- "Build, test, and deploy the current project to the staging environment"
- "Search GitHub issues and PRs by keyword, label, or assignee"
- "Generate a weekly analytics report from the PostgreSQL database"
- "Create, structure, and validate new skills"

## Examples of Bad Descriptions

- "Deployment" (too vague — when does it trigger?)
- "A skill that helps with various coding tasks" (not specific)
- "This skill is used for searching things on the internet" (wordy, no clear trigger)
