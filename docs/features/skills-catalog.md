---
id: skills-catalog
title: 'Skills Catalog'
sidebar_label: 'Skills Catalog'
---

# Skills Catalog

A **Skill** is a reusable, versioned block of Markdown-with-frontmatter
instructions that an Agent pulls in when it's relevant — the same
`SKILL.md` shape used by the open **agentskills** standard. Ever Works
ships Skills as a plugin capability (`skills-provider`) and sources a
curated public catalog from the [`ever-works/skills`](https://github.com/ever-works/skills)
GitHub repo.

This page covers the catalog **format**, the first-party provider
**plugin**, and how Skills **attach to Agents**. For the REST endpoints
(catalog reads, per-user installs), see the
[Skills API](/api/skills).

**Key sources:**

- `packages/plugins/everworks-skills/src/everworks-skills.plugin.ts` — the provider plugin
- `packages/plugins/everworks-skills/package.json` — plugin manifest (`autoEnable`, capability)
- [`ever-works/skills`](https://github.com/ever-works/skills) — the public catalog repo (`manifest.json` + `skills/<slug>/SKILL.md`)
- `ever-works/agents` → `schema/skills.schema.json` — the `skills.yml` attach schema

## The `SKILL.md` format

Each Skill is a folder in the catalog repo containing a `SKILL.md` file:
YAML frontmatter followed by the instruction body. The frontmatter
follows the agentskills standard — `name` and `description` are the
required keys, and additional keys are preserved as-is. A real example
from the catalog (`skills/check-pr/SKILL.md`):

```markdown
---
name: check-pr
description: >
    Check a GitHub, GitLab, or Perforce PR/MR/CL for review comments,
    failing checks, and PR-body gaps. Use when asked to inspect, fix, or
    prepare a change for submission.
license: MIT
compatibility: Requires git and gh, glab, or p4 installed and authenticated.
metadata:
    author: greptileai
    version: '1.3'
allowed-tools: Bash(gh:*) Bash(glab:*) Bash(git:*) Bash(p4:*)
---

# Check PR

Analyze a pull request … then help address any issues found.
```

The provider parses this with `gray-matter`, guaranteeing `name` and
`description` (falling back to the manifest row or slug) while preserving
any extra frontmatter keys (`allowed-tools`, `metadata`, etc.).

## The public `ever-works/skills` catalog

The catalog repo has a top-level `manifest.json` that indexes each Skill.
Every row carries a `slug`, a `skillPath` pointing at its `SKILL.md`,
plus curated `name`/`summary`/`tags`/`version` and — importantly —
**`license` and `sourceUrl` attribution** for Skills adapted from
upstream sources.

At the time of writing the catalog ships **10 Skills**, each with its
license and source attributed:

| Skill              | License    |
| ------------------ | ---------- |
| `skill-creator`    | Apache-2.0 |
| `mcp-builder`      | Apache-2.0 |
| `webapp-testing`   | Apache-2.0 |
| `frontend-design`  | Apache-2.0 |
| `brand-guidelines` | Apache-2.0 |
| `internal-comms`   | Apache-2.0 |
| `claude-api`       | Apache-2.0 |
| `check-pr`         | MIT        |
| `pr-report`        | MIT        |
| `doc-maintenance`  | MIT        |

## The `everworks-skills` provider plugin

`@ever-works/everworks-skills-plugin` is the first-party
`skills-provider` plugin. Its behavior (verified in
`everworks-skills.plugin.ts`):

- **Catalog source.** It fetches `manifest.json` from the configured repo
  and branch over a plain HTTPS GET (the repo is public — no auth), then
  fetches each row's `SKILL.md`, parses the frontmatter, and caches the
  union in memory with a configurable TTL (`cacheTtlSeconds`, default 1h,
  clamped to `[0, 86400]`).
- **Configurable target.** Admin settings `catalogRepo`
  (`PLUGIN_EVERWORKS_SKILLS_REPO`, default `ever-works/skills`) and
  `catalogBranch` (`PLUGIN_EVERWORKS_SKILLS_BRANCH`, default `main`)
  point it at a different catalog; both are validated against strict
  repo/branch patterns. The plugin is `admin-only`.
- **`BUILTIN_CATALOG` fallback.** If the repo is unreachable, the
  manifest is malformed, or any `SKILL.md` fetch fails, the plugin falls
  back to a small built-in catalog so it always returns _something_ and
  self-recovers when the repo is reachable again. The fallback contains
  **three** built-in Skills: `cron-defaults`, `secret-handling`, and
  `commit-message-style`.
- **Update checks.** `checkForUpdates(installedVersions)` compares
  installed versions against the catalog and reports the Skills whose
  version changed.

### `autoEnable`

The plugin's `package.json` declares it under an `everworks.plugin`
manifest with:

```json
{
	"everworks": {
		"plugin": {
			"id": "everworks-skills",
			"capabilities": ["skills-provider"],
			"autoEnable": true,
			"defaultForCapabilities": ["skills-provider"],
			"distribution": "registry"
		}
	}
}
```

`autoEnable: true` means the platform turns the provider on without a
manual step, and `defaultForCapabilities` makes it the default resolver
for the `skills-provider` capability — so the curated catalog is
available out of the box.

## Attaching Skills to Agents

An Agent template declares which Skills it wants via a `skills.yml`
manifest. The schema (`ever-works/agents` →
`schema/skills.schema.json`) has two required arrays, `required` and
`recommended`, each a list of `{ slug, why }` entries:

- **`required`** — Skills the Create-Agent wizard **auto-attaches and
  locks**. The user can remove them, but the wizard warns.
- **`recommended`** — Skills the wizard **pre-checks** but leaves the user
  free to deselect.

Each entry needs a `slug` (kebab-case, resolved against the
`ever-works/skills` catalog) and a `why` (8–200 chars, shown as a tooltip
in the wizard). A real example (`templates/starter-coder/skills.yml`):

```yaml
required:
    - slug: git
      why: The Coder branches, commits, and pushes for every Task.
    - slug: github-pr
      why: Opening the PR, polling reviewers, and replying to inline comments.
    - slug: test-runner
      why: The Coder must run lint, type-check, and tests locally before pushing.
recommended:
    - slug: code-search
      why: Read first, edit second. A fast repo-wide search makes the read step cheap.
```

:::note Unknown slugs are ignored, not rejected
A `skills.yml` slug that doesn't (yet) resolve against the catalog is
**ignored by the wizard, not rejected** (per the schema's own
description). This keeps templates forward-compatible with Skills that
haven't landed in the catalog.
:::

## Related pages

- [Skills API](/api/skills) — catalog reads and per-user install endpoints.
- [Agents Catalog](./agents-catalog.md) — the starter-agent templates that
  ship the `skills.yml` manifests.
- [Agents (Your AI Employees)](./agents.md) — the Agent product concept.
