---
id: agents-catalog
title: 'Agents Catalog'
sidebar_label: 'Agents Catalog'
---

# Agents Catalog

When you create an [Agent](./agents.md), you can start from a **template**
— a pre-built specialist (a PM, a Coder, a Researcher, …) with an
identity, a role prompt, default Skills, and a starter knowledge base.
These templates live in the separate [`ever-works/agents`](https://github.com/ever-works/agents)
GitHub repo and are surfaced in the Create-Agent wizard as chips and a
**View All** catalog.

This page covers the **catalog repo structure**, the **starter agents**,
and **how the platform reads it**. For the Agent runtime and REST surface,
see [Agents (Your AI Employees)](./agents.md) and the
[Agents API](/api/agents).

**Key sources:**

- `apps/api/src/agents/agent-template-catalog.service.ts` — the catalog reader
- `apps/api/src/agents/agent-templates.controller.ts` — `GET /api/agent-templates`
- [`ever-works/agents`](https://github.com/ever-works/agents) — the template repo (`manifest.json` + `templates/<slug>/…`)

## Catalog repo structure

The `ever-works/agents` repo has a top-level `manifest.json` that indexes
the templates, plus one folder per template under `templates/<slug>/`. A
template folder contains (verified from `templates/starter-coder/`):

```
templates/starter-coder/
  SOUL.md              # the agent's identity / persona
  .works/agent.yml     # the agent manifest (config)
  skills.yml           # default Skills to attach (required / recommended)
  kb/                  # starter knowledge base (playbooks, checklists, examples, templates)
  prompts/             # system prompt + per-task prompts
  README.md
  icon.svg
```

Each `manifest.json` `templates[]` row carries a `slug`, a display
`name`/`title`, a `summary`, a `scope` (e.g. `TENANT`, `WORK`, `MISSION`),
an `avatarIcon`, and `tags`.

The `skills.yml` file is the attach manifest documented in
[Skills Catalog → Attaching Skills to Agents](./skills-catalog.md#attaching-skills-to-agents):
its `required` / `recommended` slug lists resolve against the
`ever-works/skills` catalog.

## The 12 starter agents

The catalog ships **12 starter agents** spanning common team roles:

| Slug                 | Role       | Scope   |
| -------------------- | ---------- | ------- |
| `starter-pm`         | PM         | Tenant  |
| `starter-coder`      | Coder      | Work    |
| `starter-researcher` | Researcher | Tenant  |
| `starter-copywriter` | Copywriter | Tenant  |
| `starter-marketer`   | Marketer   | Tenant  |
| `starter-sales`      | Sales      | Tenant  |
| `starter-support`    | Support    | Tenant  |
| `starter-curator`    | Curator    | Work    |
| `starter-growth`     | Growth     | Tenant  |
| `starter-designer`   | Designer   | Work    |
| `starter-devops`     | DevOps     | Work    |
| `starter-founder`    | Founder    | Mission |

_(The `scope` column reflects each template's `scope` in `manifest.json`
and controls where the resulting Agent operates — across the whole
Tenant, a single Work, or a Mission.)_

## How the platform reads the catalog

`AgentTemplateCatalogService.list(entity)` (backed by
`GET /api/agent-templates?entity=agent`) fetches `manifest.json` from
`ever-works/agents`, maps each row to the stable `AstTemplateEntry` shape
the web app consumes, and caches it for **1 hour** in the shared cache
store. Details verified in `agent-template-catalog.service.ts`:

- **Only `agent` is repo-backed.** Requests for `skill` / `task` entity
  types return `[]`; the web layer keeps its own fallback for those.
- **Resilient by design.** Every failure path — no token, repo
  unreachable, malformed manifest — returns an empty array, so the web
  app falls back to its built-in list and the chips never break.
- **Security hardening.** Because the manifest is external input, the
  reader rejects slugs that don't match a strict allowlist, strips HTML
  from every string field, and caps field lengths — so a compromised repo
  can't inject XSS into the catalog UI.

### Authentication

The `ever-works/agents` repo is private. The reader resolves a GitHub
token in priority order:

1. **The platform GitHub App's installation on the `ever-works` org** —
   the same App that already lets the platform create repos there. No
   extra secret is needed in the standard hosted deployment.
2. **`EVER_WORKS_AGENTS_TOKEN` / `GITHUB_TOKEN`** env override — for
   self-hosted installs that don't run the GitHub App, or local dev.

When neither resolves, the service logs once and returns `[]`.

:::caution Pin the ref in production
The catalog ref is `EVER_WORKS_AGENTS_REF` (default `main`). The service
**warns** when it's a mutable branch and recommends pinning to a commit
SHA (40 hex chars) or a version tag (`vX.Y.Z`) in production, to prevent
supply-chain substitution after the cache expires.
:::

## Related pages

- [Agents (Your AI Employees)](./agents.md) — the Agent product concept and runtime.
- [Agents API](/api/agents) — CRUD + runtime endpoints.
- [Skills Catalog](./skills-catalog.md) — the `skills.yml` attach model and the Skills catalog.
