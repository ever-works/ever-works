# Feature Specification: Agent Memory

**Feature ID**: `agent-memory`
**Status**: `Shipped` (documented as-built)
**Jira Epic**: [EW-672](https://evertech.atlassian.net/browse/EW-672)
**Created**: 2026-05-28
**Last updated**: 2026-05-28
**Owner**: Product (Ruslan)
**Shipped via PRs**: #1073 (plugin), #1081 (pipeline-step), #1082 (rollback), #1084 (sessions), #1086 (API controllers), #1090 (canSkipAtBuildTime + session pipe), #1095 (session pipe finish)

**Related code today**:

- Capability contract: `packages/plugin/src/contracts/capabilities/agent-memory.interface.ts`
- Step facade: `packages/plugin/src/facades/agent-memory-facade.interface.ts`
- First-party provider: `packages/plugins/agentmemory/` (external REST backend)
- Pipeline modifier: `packages/plugins/memory-pipeline-modifier/`
- Bound facade: `packages/agent/src/facades/agent-memory.facade.ts`
- Pipeline wiring: `packages/agent/src/pipeline/pipeline-facade.service.ts`, `step-pipeline-executor.service.ts`, `full-pipeline-executor.service.ts`
- REST surface: `apps/api/src/plugins-capabilities/agent-memory/`
- Run-level session lifecycle: `packages/agent/src/services/agent-run.service.ts`

---

## 1. What it is

Agent Memory gives Works and agent runs **persistent, retrievable memory** across
generations: a run can fetch a digest of what prior runs learned and save a short
observation at the end, so the next run starts informed rather than cold.

Memory is **not stored in Postgres.** It lives entirely in an external
agent-memory REST backend (default `@ever-works/agentmemory-plugin`, base URL
`http://localhost:3111`), partitioned by a `project` namespace (derived from the
Work slug/id). The **only** Postgres surface is a single nullable column,
`agent_runs.memorySessionId` (migration
`1779991011000-AddMemorySessionIdToAgentRuns.ts`), which records the opaque
session id an agent run opened so the run row can be correlated with its memory
session. Memory being external is a deliberate design choice — no migration
exists for "memory entries" because there is no memory table.

---

## 2. Personas + use cases

| Persona  | Use case                                                                                     |
| -------- | -------------------------------------------------------------------------------------------- |
| Operator | Enables an agent-memory provider so Works accumulate context across scheduled regenerations. |
| User     | Turns on "Agent Memory Hooks" for a Work; each run fetches prior context and saves a digest. |
| User     | Reviews / forgets individual memory observations from the admin UI.                          |
| Agent    | An agent run opens one memory session and shares it across everything it does in that run.   |

---

## 3. Capability contract

`IAgentMemoryPlugin` (full) / `IAgentMemoryStepFacade` (bound, exposed to pipeline
steps) expose: `openSession`, `closeSession`, `saveMemory`, `searchMemory`,
`buildContext`, `deleteEntry`, `listSessions`. `listSessions` is optional on the
plugin — the default `agentmemory` provider does not implement it yet, so
`GET /api/agent-memory/sessions` returns 404 against that backend. All calls are
**best-effort** at the consumption sites: a memory failure must never crash a
host pipeline or agent run.

---

## 4. Sessions and the session pipe

A **session** groups the reads/writes of one logical unit of work so the backend
can relate them (recall, recency, slot tracking). Two producers open sessions:

1. **Agent runs** (`AgentRunService`) — open a session per run via
   `tryOpenMemorySession`, persist its id to `agent_runs.memorySessionId`, and
   close it when the run ends. Fully wired and best-effort (a no-provider or
   DB hiccup never fails the run).

2. **Work-generation pipelines** (via the `memory-pipeline-modifier`). The
   modifier injects two steps — `memory-fetch-context` (position `first`) and
   `memory-save` (position `last`) — into step-orchestratable pipelines
   (`standard-pipeline`, `agent-pipeline`).

**Session sharing (the "session pipe").** `StepExecutionContext.memorySessionId`
carries an orchestrator-supplied session id down to every step.
`PipelineExecutionOptions.memorySessionId` lets a caller that already opened a
session (e.g. an agent run that triggers a pipeline) hand it in; both pipeline
executors forward it to `PipelineFacadeService.createStepExecutionContext`, which
places it on the step context. When this id is present, the memory modifier
associates its fetch / save / rollback with that shared session instead of
opening its own.

When **no** orchestrator session is supplied (the common case for plain
Work-generation runs), the `memory-fetch-context` step **opens one per-run
session of its own**, stashes it on the pipeline context, and the `memory-save`
step and the failure `rollback` reuse it — so the context read, the success
digest, and any failure digest all land on the **same** session row. The modifier
closes a session it opened itself at the terminal step (save, save-disabled exit,
or rollback); it never closes an orchestrator-supplied session (the caller owns
that lifecycle). All of this is best-effort: a failure to open/close a session
is swallowed and the run continues session-less.

---

## 5. Rollback semantics

`memory-save` only runs on **success** (it's the `last` step; the executor breaks
out of the step loop before reaching it on failure/cancellation). To persist a
digest for failed or cancelled runs, the modifier implements
`IPipelineModifierPlugin.rollback(context, error)`, which the step executor
invokes for every plugin modifier that contributed steps. Rollback tags the
observation `failed` vs `cancelled` (AbortError / cancellation detection) and is
wrapped in its own try/catch so a faulty rollback can never mask the original
pipeline error.

---

## 6. `canSkipAtBuildTime`

The modifier is **opt-in** (`enabled` setting, default off, work-scoped).
`canSkipAtBuildTime` lets the pipeline builder skip injecting the two steps
entirely when the modifier is disabled — zero overhead (no STEP_STARTED events,
no metrics, no executor branching) on Works that don't use memory. A defensive
`enabled` guard remains inside `execute()` for hosts that don't honour
`canSkipAtBuildTime`.

---

## 7. REST surface

Mounted at `/api/agent-memory`, JWT-protected (`AuthSessionGuard`):

| Method + path                         | Notes                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `GET /check-availability`             | Whether a provider is registered + loaded.                              |
| `POST /sessions`                      | Open a session. Ownership-checked when `workId` supplied.               |
| `POST /sessions/:sessionId/close`     | Close a session. Ownership-checked + work-scoped when `workId` given.   |
| `GET /sessions`                       | List sessions (404 if provider lacks `listSessions`).                   |
| `POST /save` / `/search` / `/context` | Save / search / build-context. Ownership-checked when `workId` given.   |
| `DELETE /entries/:entryId`            | Forget one record. Ownership-checked + work-scoped when `workId` given. |

**Ownership / isolation.** When a request carries a `workId`, the controller
runs `WorkOwnershipService.ensureCanView(workId, userId)` and scopes provider
resolution to that Work. The id-addressed mutations (`close`, `deleteEntry`)
accept an optional `workId` query param so they get the same check — without it
they operate against the caller's default project. Cross-user isolation
therefore depends on per-user / per-work `project` separation being configured in
the backend.

---

## 8. Hard rules (additive)

- Memory is **always best-effort** — never throw into a host pipeline or run.
- The feature is **opt-in** per Work; default off.
- Storage is **external**, not Postgres; the only DB column is
  `agent_runs.memorySessionId`.
- An orchestrator-supplied session id always wins over a self-opened one, and the
  modifier never closes a session it did not open.
