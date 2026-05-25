# ADR-006: Agents, Skills, and Tasks are core concepts, not plugins

## Status

**Partially superseded — 2026-05-25.**

- ✅ **Agents** — decision stands. Agents (entity, runtime, scope cascade, prompt assembly) remain core. The Agent's executor still uses **agentic-pipeline plugins** (e.g. `claude-code`, `claude-managed-agent`, `agent-pipeline`, `codex`, …) for the AI execution — Agent runtime is core, the runtime's worker is a plugin choice.
- ❌ **Skills** — superseded by [ADR-012](./012-skills-as-plugin.md). Skills are now a plugin capability with `"Ever Works Skills"` as the first-party plugin.
- ❌ **Task tracking** — superseded by [ADR-013](./013-task-tracking-as-plugin.md). Task TRACKING (storage / CRUD) is now a plugin capability with `"Ever Works Task Tracker"` as the first-party plugin. The Task CONCEPT (entity, state machine, Agent integration) stays core.

Operator's round-6 instruction reversed the "Skills/Tasks core" portions. The Skills + Task-tracking spec set retains its product behavior unchanged; only the implementation packaging moves from "core service" to "plugin capability + facade." Historical content below is retained for context.

---

**Original (Accepted — Proposed 2026-05-25)**, pending implementation in `feat/agents`, `feat/skills`, `feat/task-tracking`.

## Date

2026-05-25

## Context

Ever Works' Constitution Principle I — "Plugin-First, NON-NEGOTIABLE" — establishes that every external integration must ship as a standalone plugin under `packages/plugins/<id>/`. The platform today honors this for 39 plugins spanning AI providers, search, screenshot, content extraction, git providers, deployment, pipelines, and utility plugins.

When designing the new **Agent**, **Skill**, and **Task** concepts (see [`features/agents/spec.md`](../features/agents/spec.md), [`features/skills/spec.md`](../features/skills/spec.md), [`features/task-tracking/spec.md`](../features/task-tracking/spec.md)), an obvious question was whether each new concept should be packaged as a plugin category — e.g. an "agent-runtime" plugin category with `claude-managed-agent` / `agent-pipeline` / `codex` as competing implementations, a "skills" plugin shipping a catalog, and a "task-tracker" plugin owning task storage.

The operator's instruction was explicit:

> "concepts of Tasks, Skills and Agents are CORE concepts, so we don't need those to be implemented as plugins per se. They will USE plugins that enabled, yes."

This ADR captures that decision and its reasoning so future contributors don't try to refactor these into plugin categories under cover of Principle I.

## Decision

**Agents, Skills, and Tasks are first-class core domain concepts of the Ever Works platform — entities in the core schema, services in `packages/agent/`, surfaces in `apps/api/` and `apps/web/`. They are NOT plugin categories. They are NOT individually implemented by plugins.**

They DO use the existing plugin system:

- An **Agent** picks its AI provider via `AiFacadeService` (capability-driven resolution against an `ai-provider` plugin).
- An **Agent** picks its Git provider via `GitFacadeService` against a `git-provider` plugin.
- An **Agent** can be told to call search / screenshot / content-extractor plugins from inside its prompts; the plugin layer remains the integration boundary.
- A **Skill** may declare `allowed-tools: [github, semgrep]` in its frontmatter; the tool names map to plugin IDs whose facades the AI invokes.
- A **Task** lives in core tables in v1; a future `task-tracker` plugin capability is **reserved** but not consumed (see Reservation below).

### Reservation: future plugin capability `task-tracker`

Even though Task storage is core, a **future** plugin capability `task-tracker` is declared from day one:

```typescript
// packages/plugin/src/contracts/capabilities/task-tracker.interface.ts
export interface IExternalTaskTrackerPlugin extends IPlugin {
    listTasks(filter): Promise<ExternalTaskDto[]>;
    createTask(input): Promise<ExternalTaskDto>;
    updateTask(id, patch): Promise<ExternalTaskDto>;
    deleteTask(id): Promise<void>;
    listChat(taskId): Promise<ExternalChatDto[]>;
    postChat(taskId, body): Promise<ExternalChatDto>;
}
```

The interface is declared in v1, no plugin implements it, and no facade consumes it. The point is to give a future Linear / GitHub Issues / Jira plugin a clean place to land without a major refactor.

Agents and Skills do NOT get analogous reserved plugin capabilities — the operator's instruction was unambiguous that they are core, and a "runtime" plugin capability for Agents would actively conflict with the design (an Agent's "runtime" is itself an AI provider plugin, which already exists).

## Consequences

### Positive

- **One canonical place to read each concept.** `apps/api/src/agents/agents.controller.ts` is the only API for Agents — no plugin-per-tenant proliferation, no two divergent Agent runtimes.
- **Predictable data model.** Agents/Skills/Tasks have their own tables (`agents`, `skills`, `tasks`, …). Cross-feature queries (e.g. "show all tasks blocked by Agent X's last failed run") are joins in one DB, not federations across plugin DBs.
- **Better UX coherence.** Every Agent goes through the same lifecycle, status enum, dashboard, budget tab. No surprises like "this Agent has different settings shape because it's from plugin Z."
- **Easier observability.** One `agent_runs` table, one `tasks` table, one `activity_log` event vocabulary. Sentry tags, PostHog events, admin dashboards all read from a single source.
- **Less burden on Constitution Principle I.** Principle I exists so external integrations stay swappable; Agents/Skills/Tasks are not external integrations — they're the platform's own concepts.

### Negative

- **Loses the optional "swap Agent runtime via plugin" flexibility.** If a user really wanted to back Agents with a different runtime (e.g. LangGraph orchestration) wholesale, they'd have to fork the platform rather than installing a plugin. Mitigated by: Agents use the AI-provider plugin layer, so swapping the underlying LLM stack is still trivial.
- **Adds tables to the core schema.** Each new concept brings ≥5 tables (entities + join tables). Mitigated by: forward-only migrations are already routine on the platform.
- **The `task-tracker` capability is "decorative" in v1.** Reviewers might call it dead code. Mitigated by: documented here + in [`plugin-sdk.md`](../architecture/plugin-sdk.md) as a known forward-compat decision.

### Mitigations

- **Document the boundary clearly.** Every Agents / Skills / Tasks spec opens with the line "core concept, not a plugin"; this ADR is the canonical source.
- **Reserve `task-tracker` to keep the door open.** When a real implementation lands, the existing TaskService gets a facade-style proxy branch and the native path stays in place as the default.
- **Tests asserting reservation is reachable.** A contract test in `packages/plugin/src/contracts/__tests__/task-tracker.spec.ts` keeps the interface from rotting.

## Alternatives Considered

### 1. "agent-runtime" plugin category

**Rejected.** Would require Agent storage to also be pluggable to avoid a half-pluggable design (the runtime calls AI but reads/writes core Agent tables — awkward). Operator's instruction is explicit. And, importantly, the existing "pipeline" plugin category (`agent-pipeline`, `claude-managed-agent`, `codex`, etc.) already provides the swappable agent-loop-runtime concept for Work generators. Recreating that for user-defined Agents would duplicate without adding choice — user-defined Agents care about the AI **provider**, not the **orchestration runtime**.

### 2. "task-tracker" plugin category, no native tasks

**Rejected for v1.** Would force every new tenant to install a plugin just to track basic tasks, raising the floor of zero-friction onboarding. Operator's design positions Tasks as a default-on first-class object. The reserved interface keeps the door open without forcing the choice now.

### 3. "skills" plugin category supplying the catalog

**Rejected.** The starter catalog is small enough to ship in-repo (`apps/api/src/skills/catalog/`) and version atomically with the code. Distributing the catalog as a plugin would create a chicken-and-egg ("you need the skills plugin installed before you can install other skills"). Custom user skills don't need a plugin — they're just `skills` rows.

### 4. Make Tasks a pure view on top of Agent-run logs

**Rejected.** Tasks have first-class semantics (parent/child, blockers, approvers, chat) that don't map onto run logs without a parallel join graph. The cost of a dedicated `tasks` table is justified.

## Related

- Constitution Principle I: [`.specify/memory/constitution.md`](../../../.specify/memory/constitution.md)
- Architecture: [`../architecture/agents-skills-tasks.md`](../architecture/agents-skills-tasks.md)
- Features: [`../features/agents/spec.md`](../features/agents/spec.md), [`../features/skills/spec.md`](../features/skills/spec.md), [`../features/task-tracking/spec.md`](../features/task-tracking/spec.md)
- Plugin SDK: [`../architecture/plugin-sdk.md`](../architecture/plugin-sdk.md)
- ADR-002 (worker callback channel): [`./002-trigger-worker-callback-channel.md`](./002-trigger-worker-callback-channel.md)
- ADR-005 (cache & lock pluggability): [`./005-cache-and-lock-pluggability.md`](./005-cache-and-lock-pluggability.md) — useful comparison: pluggability where it lowers the floor (locks/caches), core where it lowers the ceiling (Agents/Skills/Tasks).
