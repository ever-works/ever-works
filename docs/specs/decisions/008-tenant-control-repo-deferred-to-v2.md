# ADR-008: Tenant control repo deferred to v2; v1 stores tenant Agents inline in DB

## Status

**Proposed — 2026-05-25.** Pending operator review on [QUESTIONS-agents-skills-tasks.md A1](../QUESTIONS-agents-skills-tasks.md#a1--tenant-control-repo-ship-in-v1-or-defer-to-v2).

## Date

2026-05-25

## Context

The Agents feature ([features/agents/spec.md](../features/agents/spec.md)) introduces user-defined Agents at four scopes: Tenant, Mission, Idea, Work. Each scope except Tenant has a natural "owning repo" — Mission has `Mission.missionRepo`; Idea is owned by parent Mission's repo; Work is owned by `Work.dataRepo`. **Tenant has none.**

Three options were considered for storage of tenant-scoped Agent files (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`, `agent.yml`):

1. **Inline in DB** — five TEXT columns on the `agents` row.
2. **Tenant control repo (`<user>-control` or `<gh-username>-control`)** — a per-user GitHub repo created at signup or first tenant Agent.
3. **Force scoping** — disallow tenant Agents in v1; users pick Mission or Work for every Agent.

Option 2 has Constitution Principle III "Source-of-Truth Repositories" working in its favor. Option 1 deviates from that principle.

## Decision

**For v1, store tenant-scoped Agent files inline in DB.** The `agents` table carries five TEXT columns (`soulMd`, `agentsMd`, `heartbeatMd`, `toolsMd`, `agentYml`) populated for tenant scope; null for Mission/Idea/Work scope (where files live in the scope's repo).

The API surface (`GET/PUT /agents/:id/files/:name`) abstracts the storage choice — callers see the same shape whether the source is Git or DB.

When v2 ships a tenant control repo concept, a **one-click "export tenant Agents to control repo" migration** offered in the UI moves these files from DB to the new repo and nulls the TEXT columns.

## Consequences

### Positive

- **Faster v1 ship.** No signup hook, no per-user repo scaffolder, no GitHub-API rate-limit handling for control-repo creation.
- **Zero blockers for new users.** Anyone signed in can create a tenant Agent immediately, even without granting the GitHub permission scope needed to create repos.
- **Unified API.** `GET /agents/:id/files/:name` returns the body regardless of storage path; UI is identical.
- **Easy v2 migration.** A pure data-move script — no schema change to entities, just null out TEXT columns + create files in the new repo.

### Negative

- **Constitution III deviation.** Tenant Agent definitions are NOT in Git in v1. Mitigated by: deviation is bounded (only tenant scope; all other scopes are in Git), documented (this ADR), and time-limited (export in v2).
- **No Git history of tenant Agent file changes.** Users can't `git log SOUL.md` on a tenant Agent. Mitigated by: activity log records every `AGENT_FILE_EDITED` event with diff (truncated to 5 KB).
- **No portability before v2.** A user can't transfer their tenant Agents to another platform install or share them via Git URL. Mitigated by: planned export.
- **No PR review of tenant Agent edits.** Edits land directly. Acceptable since these are personal Agents; PR review is for shared content.

### Mitigations

- **DB column size cap.** Each TEXT column soft-capped at 64 KB; UI shows a warning approaching cap.
- **Hash + activity log every change.** Same `contentHash` + `AGENT_FILE_EDITED` event as Git-backed Agents.
- **Read API identical.** Move from v1 to v2 doesn't change the controller; only the underlying service.
- **Migration path documented now.** v2 PR will read this ADR.

## Alternatives Considered

### 1. Tenant control repo in v1

**Rejected for scope.** Adds ≥2 weeks of work (signup hook, repo scaffolder, GitHub-OAuth scope upgrade prompt for users without `repo` scope, retry/idempotency for repo creation, conflict handling if user already has a `<gh-username>-control` repo). Not the highest-leverage thing to ship first.

### 2. Force scoping

**Rejected.** Tenant Agents are an explicit user request: "Agent can be either global for the whole Tenant ... or connected to selected Work(s), Idea(s) and Mission(s)." Removing tenant scope to dodge the storage question is product regression.

### 3. Store tenant Agents in the user's first-created Mission repo

**Rejected.** Coupling tenant scope to a specific Mission's repo creates weird semantics ("why is my tenant CEO's identity in the cats-business Mission?"). Confuses ownership.

### 4. Hybrid — DB-inline by default, Git when user opts in by configuring a control repo URL in settings

**Possible for v2.** Lets users provide their own repo (e.g. their existing personal repo) rather than the platform creating one. v1 stays DB-inline; v2 adds the optional setting.

## Related

- [`features/agents/spec.md §3.6, §8 Q1`](../features/agents/spec.md)
- [`architecture/agents-skills-tasks.md §4.5`](../architecture/agents-skills-tasks.md)
- Constitution Principle III: [`.specify/memory/constitution.md`](../../../.specify/memory/constitution.md)
- ADR-006 (Agents are core, not plugins): [`./006-agents-skills-tasks-as-core-not-plugins.md`](./006-agents-skills-tasks-as-core-not-plugins.md)
