# Agent Collaborators — implementation notes

Branch: `session/feat-collaborators` (worktree `wt-feat-collaborators`, based on `origin/develop`).

## What shipped

Per-agent **Collaborators**: an allow-list of the owner's OTHER agents that a given
agent may spawn/delegate to as sub-agents, layered ON TOP of the existing sub-agent
delegation pipeline (judgment layer G9). Zero configuration keeps exactly the legacy
behaviour (delegation to self only); enabling collaborators makes named children
admissible through every delegation path (chat tool, workflow `agent.delegate` node,
any future caller), because enforcement lives in the single runner choke point.

## Data model

- **Entity** `AgentCollaborator` → table `agent_collaborators`
  (`packages/agent/src/entities/agent-collaborator.entity.ts`):
  `id` uuid pk, `userId` (owner of both ends), `agentId` (parent), `collaboratorAgentId`,
  `enabled` boolean default true, `tenantId`/`organizationId` nullable Tier C denorm,
  `createdAt`/`updatedAt`. UNIQUE(`agentId`,`collaboratorAgentId`); reverse index on
  `collaboratorAgentId`; index on `userId`.
- Registered in `entities/index.ts`, `database/_entities-inventory.ts`,
  `database/_entity-names.ts` (drift specs stay green).
- **Migration** `apps/api/src/migrations/1785010000000-CreateAgentCollaborators.ts` —
  portable Table API, idempotent guard, FKs to `agents.id` CASCADE on BOTH ends
  (guarded on `hasTable('agents')`), spec at
  `apps/api/src/migrations/__tests__/CreateAgentCollaborators.spec.ts`.
  `agentId != collaboratorAgentId` is a SERVICE guard (repository throws + controller
  400), not a DB CHECK — no migration here uses TableCheck and CHECK quoting is not
  portable across the postgres/better-sqlite3 pair; the runner treats a self edge as
  allowed anyway, so a smuggled row would be inert.
- **Repository** `AgentCollaboratorRepository`
  (`packages/agent/src/database/repositories/agent-collaborator.repository.ts`):
  `listForAgent`, `listEnabledForAgent`, `listAgentsAllowing`, `upsert` (idempotent,
  self-edge throws), `remove`, `deleteAllForAgent`. Provided + exported by the
  agent-side `AgentsModule`; re-exported from `@ever-works/agent/database` and
  `@ever-works/agent/agents`.

## Contracts

`packages/contracts/src/delegation/sub-agent-delegation.types.ts`:

- `SubAgentDelegationRefusalCode` gains **`collaborator-not-allowed`** (append-only;
  the vitest pin was updated).
- New pure helper **`evaluateCollaboratorDelegation(parentAgentId, childAgentId, rules)`**
  (+ `SubAgentCollaboratorRule` / `SubAgentCollaboratorDecision`): self ⇒ allowed;
  named child ⇒ requires an `enabled` rule; disabled vs missing get distinct messages.
  Unit-tested in `src/delegation/__tests__/sub-agent-delegation.spec.ts`.

## Enforcement (the choke point)

`apps/api/src/agents/sub-agent-delegation.runner.ts`
(`SubAgentDelegationRunnerService.run`): after the existing same-owner check, a
delegation whose `childAgentId` differs from the parent loads the parent's rules and
runs `evaluateCollaboratorDelegation`; a negative decision returns a typed REFUSAL
(`refuseSubAgentDelegation(..., 'collaborator-not-allowed', ...)`), not a failure.
`AgentCollaboratorRepository` is injected NON-optionally (a security gate must not
fail open; TasksModule already imports the agent-side AgentsModule that exports it).
Ownership is checked BEFORE the allow-list, so an enabled rule can never launder a
cross-owner child. Spec updated: `sub-agent-delegation.runner.spec.ts` (refusal on
no-rows / disabled row, pass-through on enabled row, self-delegation never consults
the list, cross-owner precedence).

## New agent tool `delegateToAgent`

`packages/agent/src/agents/agent-tool.service.ts`:

- Gated on `permissions.canAssignTasks` (same capability class as the task tools and
  `run_workflow_graph`) + both `SubAgentDelegationService` and
  `AgentCollaboratorRepository` being bound (both appended LAST + `@Optional()`, so
  every positional spec constructor keeps compiling and legacy runtimes expose nothing).
- Input `{ targetAgentId | targetAgentSlug, objective, context? }` → drives the SAME
  `SubAgentDelegationService.delegate` path as the workflow node with
  `childAgentId=target`, `scope.allowedTools=['*']`, `limits.parentScope` = the
  parent's own lazily-resolved tool set + `networkAccess=canCallExternalTools`, a
  bounded per-run `siblingCount` (500-run evicting map, mirroring
  `WorkflowNodeRunnerService`), 5-minute duration budget, and `parentRunId` from the
  run context (feeds the server-derived depth resolver).
- Target resolution runs against SELF + ENABLED collaborators only (owner-scoped agent
  loads) — unknown/disabled/foreign targets error with the current enabled roster
  (name + slug) so the model can self-correct; nothing probes the agent table.
- Spec: `packages/agent/src/agents/__tests__/agent-tool-delegate.spec.ts` (11 tests).

## API

`apps/api/src/agents/agent-collaborators.controller.ts` (registered in the api-side
`AgentsModule`; its module pin spec got the matching controller stub):

- `GET    /api/agents/:id/collaborators` — every OTHER agent of the owner (cap 200)
  as `{agentId,name,slug,title,status,avatarMode,avatarIcon,configured,enabled}`.
- `PUT    /api/agents/:id/collaborators/:collaboratorAgentId` — body
  `UpdateAgentCollaboratorDto { enabled: boolean }` (whitelisted), idempotent upsert.
  Self edge → 400. Both ends ownership-checked via `AgentsService.getOne` (cross-user
  = 404, no existence leak). Throttled 30/min.
- `DELETE /api/agents/:id/collaborators/:collaboratorAgentId` — removes the rule,
  `{removed: boolean}`, idempotent.

Spec: `agent-collaborators.controller.spec.ts` (list shape/state merge, self-400,
foreign-404, delete idempotency, DTO ValidationPipe cases incl. forbidNonWhitelisted).

## Web UI

- New tab **Collaborators** in `AgentDetailTabs` (between Skills and Budgets), route
  `ROUTES.DASHBOARD_AGENT_COLLABORATORS` → `/agents/[id]/collaborators`.
- Server page `apps/web/src/app/[locale]/(dashboard)/agents/[id]/collaborators/page.tsx`
  composes agent (404 gate) + candidate list.
- `apps/web/src/components/agents/AgentCollaboratorsClient.tsx` — roster of the
  owner's other agents (avatar initials, name, slug, role line) each with a `Switch`;
  optimistic toggle through server actions with rollback + toast; explanatory copy +
  legacy-default note.
- API wrappers `agentsAPI.listCollaborators/setCollaborator/removeCollaborator`
  (`lib/api/agents.ts`), client-safe `AgentCollaboratorCandidate` in
  `lib/api/agents.shared.ts`, server actions
  `listAgentCollaboratorsAction/setAgentCollaboratorAction/removeAgentCollaboratorAction`
  (`app/actions/agents.ts`).
- i18n: `dashboard.agentsPage.tabs.collaborators` +
  `dashboard.agentsPage.collaborators.*` added to ALL 21 locale files (English values
  copied verbatim per convention).

## Test commands

```bash
cd packages/contracts && npx vitest run src/delegation/__tests__/sub-agent-delegation.spec.ts
cd packages/agent   && npx jest --testPathPattern='agent-tool-delegate'
cd apps/api         && npx jest --testPathPattern='sub-agent-delegation.runner|agent-collaborators.controller|agents.module|CreateAgentCollaborators'
```

Type-check/build: `npx turbo type-check --filter=@ever-works/contracts --filter=@ever-works/agent --filter=ever-works-api --filter=ever-works-web`
(shared packages must be built first: `npx turbo build --filter=ever-works-api^...`).

## Divergences from the brief (code wins)

- The brief named the runner file `sub-agent-delegation.runner.service.ts`; the real
  file is `sub-agent-delegation.runner.ts` (class name matches the brief).
- The brief asked for the tool descriptor to LIST enabled collaborators in its
  description. `resolveAllowedTools` is synchronous by contract (no I/O at
  descriptor-build time), so the roster is surfaced at INVOKE time instead: any call
  with a missing/unknown/disabled target errors with the current enabled list
  (name + slug). Documented in the builder's doc comment.
- The brief said "no collaborator rows = exactly today's behavior", describing today
  as self-only. Strictly, today's runner admitted ANY same-owner `childAgentId`; no
  production caller ever set one (the workflow node doesn't), so implementing the
  brief's self-only-when-unconfigured semantics changes no observable behaviour while
  making the allow-list opt-in rather than implicit.
- The brief's "CHECK/service-guard" option for `agentId != collaboratorAgentId` was
  resolved as service-guard only (portability; see Data model above).
- No new DI tokens were bound, so no module-shape pin gained providers; the api-side
  `agents.module.spec.ts` only needed the new controller stubbed.

## Known follow-ups

- Activity-log rows for collaborator enable/disable (would need a new additive
  `ActivityActionType`; skipped to keep the enum untouched in this slice).
- Surface the `collaborator-not-allowed` refusal in the Sessions/Task UI with a
  deep link to the Collaborators tab.
- Playwright e2e for the tab (toggle → refusal path) — cheap once a seeded
  two-agent fixture exists.
- `deleteAllForAgent` is available but hard agent deletes already cascade via FK;
  wire it into any soft-delete cleanup if agents ever stop being FK-cascaded.
