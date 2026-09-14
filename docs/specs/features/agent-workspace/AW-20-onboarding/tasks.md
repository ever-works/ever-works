# AW-20 — First-hour onboarding and provisioning · Task List

**Epic:** `AW-20-onboarding` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md)
**Status:** Draft v1 · **Date:** 2026-09-06

Execute top to bottom. Every task names the exact files to create or modify and
what "done" means. Phases are independently shippable; each ends with `develop`
green.

**Repo commands used below** (from `CLAUDE.md`): `pnpm lint`, `pnpm type-check`,
`cd apps/api && pnpm test`, `cd packages/agent && pnpm test`,
`cd apps/web && pnpm test`, `cd apps/web && pnpm test:e2e`,
`cd apps/api && pnpm typeorm migration:run -d typeorm.config.ts`.

**Two standing rules for this epic.**

1. Nothing existing is deleted, renamed or reordered. If a task looks like it
   needs to, stop and re-read [plan.md §12](./plan.md#12-constitution-compliance).
2. Every i18n leaf name is camelCase and contains **no literal dot**. A missing
   _parent_ key collapses a whole locale subtree.

---

## Phase 1 — The roster

Ships: a new setup step that provisions a wired roster — a coordinator plus
lane-owning specialists, with reporting lines, delegation and skills — plus the
progress panel and the introduction. No checklist, no Home surface.

---

### T-01 · Contracts: roster vocabulary

**Phase:** P1
**Create:** `packages/contracts/src/api/onboarding/roster.ts`

Export, exactly as in [plan.md §3.4](./plan.md#34-new-enums-and-shapes-contracts):
`ROSTER_LANE_KEYS` (`as const` tuple of the seven lane keys) with derived type
`RosterLaneKey`; `ROSTER_BLUEPRINT_SLUGS` (five slugs) with `RosterBlueprintSlug`;
`ROSTER_MAX_LANES = 8`; `ROSTER_NAME_MAX = 60`.

Doc-comment each referencing the FR it encodes (FR-6, FR-7, FR-26, FR-30) and
stating that a lane is a **label, not a permission** (FR-27) so a later reader
does not wire it into an authorization path.

**Done when:** both tuples are `as const`, both derived types are unions of string
literals, and `tsc` resolves them.

---

### T-02 · Contracts: first-hour vocabulary

**Phase:** P1 (types used by P1; the checklist itself is P2)
**Create:** `packages/contracts/src/api/onboarding/first-hour.ts`

Export `ONBOARDING_MILESTONES`, `OnboardingMilestoneKey`, `MILESTONE_STATUSES`,
`MilestoneStatus`, `MilestoneRecord`, `ROSTER_PROVISION_STATES`,
`RosterProvisionState`, `LANE_OUTCOMES`, `LaneOutcome`, `LANE_FAILURE_REASONS`,
`LaneFailureReason`, `RosterProvisionRecord`, `RosterLaneResult` — the shapes in
[plan.md §3.4](./plan.md#34-new-enums-and-shapes-contracts) and
[§3.5](./plan.md#35-the-provisioning-record-persisted-inside-the-checklist-row).

**Done when:** `MilestoneRecord.unknown` is documented as the FR-59 degradation
flag, and the five milestone keys are in the spec's FR-34 order.

---

### T-03 · Contracts: barrel exports

**Phase:** P1
**Modify:** `packages/contracts/src/api/onboarding/index.ts`

Add `export * from './roster.js';` and `export * from './first-hour.js';`,
matching the file's existing export style. `packages/contracts/src/api/index.ts`
already re-exports the onboarding folder — **do not edit it**.

**Done when:** `import { ROSTER_LANE_KEYS } from '@ever-works/contracts/api'`
type-checks from both `apps/api` and `apps/web`, and `pnpm type-check` passes.

---

### T-04 · The coordinator agent template

**Phase:** P1
**Modify:** `packages/agent/src/agents/agent-templates.ts`

Append a seventh entry, `workspace-coordinator`, per
[plan.md §3.7](./plan.md#37-the-seventh-agent-template):

- `category: 'ops'`, `name: 'Ada'`, `title: 'Routing and coordination'`
- `systemPrompt`: receive whatever the owner hands over; decide which lane owns
  it; delegate to that lane's agent; **raise an escalation rather than guess**
  when the lane is ambiguous; never do the specialist work itself.
- `capabilities`: free-text summary of routing, delegation and escalation.
- `suggestedSkills: ['digest-compilation']` — must exist in `GTM_SKILLS`.
- `suggestedPipeline: null`
- `defaultPermissions: { canAssignTasks: true }` — the only permission any roster
  agent gets (FR-22 depends on it).
- `defaultGuardrails: REQUIRE_APPROVAL` — reuse the existing module constant
  (FR-20).
- `suggestedRoles: []` — it is a roster fixture, not a role suggestion, and must
  not start appearing in the existing role-seeding suggestion block.

**Done when:** `AGENT_TEMPLATES.length === 7`, the existing catalog-integrity
suite still passes unmodified, and nothing in
`packages/agent/src/agents/role-seeding.ts` references the new slug.

---

### T-05 · The blueprint catalogue

**Phase:** P1
**Create:** `packages/agent/src/agents/roster-blueprints.ts`

Implement exactly the shapes in
[plan.md §3.6](./plan.md#36-the-blueprint-catalogue): `RosterLaneSpec`,
`RosterBlueprint`, `ROSTER_BLUEPRINTS` (the five blueprints with the lane orders
in the plan's table), `ROLE_BLUEPRINT_VOTES` typed
`Readonly<Record<OnboardingRoleId, RosterBlueprintSlug>>` so a new role option
without a mapping is a **type error** — the same trick `ROLE_SEED_KITS` uses —
plus the pure functions `selectBlueprint`, `laneCapForTeamSize` and
`proposeRoster`.

Rules to encode:

- `lanes[0].isCoordinator === true` in every blueprint (FR-8).
- `selectBlueprint` counts votes, breaks ties on `ROSTER_BLUEPRINT_SLUGS` order,
  and returns `general` for an empty or unrecognised role list (FR-3, FR-4).
- `laneCapForTeamSize`: `solo → 3`, `small-2-10 → 5`, `mid-11-50 → 6`,
  `large-51-200 → 8`, `enterprise-200-plus → 8`, anything else → `5` (FR-5).
- `proposeRoster` applies the cap by trimming from the **end** and never trims
  index 0.

Write the header comment in the house voice: say why the map is exhaustive and
why "nothing suggested" and "nobody wrote a mapping" must not look alike — the
same argument `role-seeding.ts` already makes.

**Done when:** the file compiles with no `any`, every function is pure, and no
blueprint exceeds `ROSTER_MAX_LANES`.

---

### T-06 · Blueprint catalogue spec

**Phase:** P1
**Create:** `packages/agent/src/agents/__tests__/roster-blueprints.spec.ts`

Cover, per [plan.md §10.1](./plan.md#101-unit--agent-package-jest-cd-packagesagent--pnpm-test):
`ROLE_BLUEPRINT_VOTES` is total over `ROLE_OPTIONS`; every `templateSlug` exists
in `AGENT_TEMPLATES`; every blueprint's first lane is the coordinator and no other
lane is; no blueprint exceeds `ROSTER_MAX_LANES`; lane keys are unique inside a
blueprint; `selectBlueprint` is deterministic across 100 shuffles of the same
role array; ties break in catalogue order; `laneCapForTeamSize` returns the five
documented numbers and `5` for `undefined`; `proposeRoster` never drops the
coordinator even at cap `1`.

**Done when:** `cd packages/agent && npx jest --testPathPattern='roster-blueprints'`
is green and fails if a lane's `templateSlug` is changed to a non-existent slug.

---

### T-07 · Extend the agent-template integrity suite

**Phase:** P1
**Modify:** `packages/agent/src/agents/__tests__/agent-templates.spec.ts`

Add assertions for `workspace-coordinator`: it exists; `category === 'ops'`;
`defaultPermissions.canAssignTasks === true`; `defaultGuardrails.mode ===
'require_approval'`; every `suggestedSkills` slug is in `GTM_SKILLS`;
`suggestedRoles` is empty. Leave every existing assertion untouched — the
"at least the six go-to-market templates" check must keep passing as written.

**Done when:** the suite is green and fails if the coordinator's guardrails are
loosened.

---

### T-08 · `lane` on the Agent entity and DTOs

**Phase:** P1
**Modify:**

- `packages/agent/src/entities/agent.entity.ts` — add
  `@Column({ type: 'varchar', length: 32, nullable: true }) lane?: string | null;`
  with a doc comment stating it is a label, carries no authorization weight
  (FR-27), and is uniquely constrained per user by a **partial** index declared in
  the migration.
- `packages/agent/src/agents/types.ts` — `AgentDto` gains `lane: string | null`;
  the mapper sets it.
- `apps/api/src/agents/dto/agent.dto.ts` — `CreateAgentDto` and `UpdateAgentDto`
  gain `@IsOptional() @Matches(/^[a-z0-9][a-z0-9-]{0,31}$/) @ApiPropertyOptional() lane?: string;`
- `packages/agent/src/agents/agent-templates.service.ts` — extend
  `CreateAgentFromTemplateInput` with `lane?: string | null` and pass it into the
  `createInput` object.

**Done when:** `pnpm type-check` passes, every existing `createFromTemplate` call
site compiles unchanged (the field is optional — Constitution X), and an agent
created without a lane still round-trips.

---

### T-09 · Migration — `agents.lane`

**Phase:** P1
**Create:** `apps/api/src/migrations/1791200000000-AddAgentLane.ts`

Class `AddAgentLane1791200000000`. `up()`:

1. `if (!(await queryRunner.hasColumn('agents', 'lane')))` → `addColumn` nullable
   `varchar(32)`.
2. Create the partial unique index
   `uq_agents_user_lane` on `("userId", "lane") WHERE "lane" IS NOT NULL` via raw
   SQL guarded by an existence check (TypeORM's `TableIndex` has no partial-index
   spelling).

`down()` drops the index then the column. No backfill: the column is nullable and
every existing row is already valid.

Header comment must state: forward-only, idempotent, additive, and name the entity
file it pairs with (Constitution V — same PR).

**Done when:** `cd apps/api && pnpm typeorm migration:run -d typeorm.config.ts`
applies cleanly on a fresh database and is a no-op on a second run.

---

### T-10 · The provisioning service

**Phase:** P1
**Create:** `packages/agent/src/agents/roster-provisioning.service.ts`

`@Injectable() RosterProvisioningService`, constructed with
`AgentTemplatesService`, `AgentsService`, the agent-collaborator repository and
the skill-binding service, plus the checklist repository (T-24) injected
`@Optional()` so P1 can ship before P2 — when it is absent the service reports
its result to the caller and persists nothing.

`execute(runId, input)` runs the state machine from
[plan.md §3.5](./plan.md#35-the-provisioning-record-persisted-inside-the-checklist-row):

1. `queued → creating`. For each lane **in blueprint order, sequentially**
   (FR-12 — copy the rationale comment from `role-seeding.service.ts`):
    - if an agent of this user already holds `lane`, record `reused` and continue
      (FR-15);
    - else `createFromTemplate(userId, templateSlug, { name, lane })`;
    - on `ConflictException`, retry with ` 2` … ` 9` appended; all taken →
      `failed: nameUnavailable` for that lane only (FR-18);
    - on `SeatLimitExceededError` → this lane and **every remaining lane**
      `skippedNoSeat`, break the loop (FR-19);
    - each attempt is abandoned after **20 s**, retried at most twice with a
      **5 s** gap (FR-13).
2. `creating → binding`. For each created agent: attach the template's
   `suggestedSkills` (a failure appends to `skillWarnings` and never fails the
   lane — FR-23); set `reportsToAgentId` to the coordinator on every
   non-coordinator; upsert an **enabled** collaborator row on the coordinator for
   every other roster agent (FR-22); call `AgentsService.resume` to move
   `draft → active` (FR-25).
3. Terminal state: `ready` when every lane is `created` or `reused`; `partial`
   when at least one succeeded and at least one did not; `failed` when none did
   (FR-10, FR-14). The whole run is abandoned at **120 s** wall clock.

Never set a heartbeat cadence (FR-21). Never touch an agent this run did not
create, except to add a reused lane's agent to the coordinator's allow-list
(FR-24).

**Done when:** the service compiles, has no direct TypeORM query outside the
repositories it is given, and never throws out of `execute` — every failure is a
recorded lane outcome.

---

### T-11 · Provisioning service spec

**Phase:** P1
**Create:** `packages/agent/src/agents/__tests__/roster-provisioning.service.spec.ts`

Cover every row of [plan.md §10.1](./plan.md#101-unit--agent-package-jest-cd-packagesagent--pnpm-test):
sequential creation order (assert call order, not just call count); an idempotent
second run reporting `reused` for every lane and creating nothing; name suffixing
2→9 then `nameUnavailable`; a mid-run seat error marking the current **and**
remaining lanes `skippedNoSeat` and ending `partial`; a skill failure producing a
warning and a `created` lane; reporting lines and enabled collaborator rows for
every non-coordinator; all created agents ending `active` with no cadence; a
lane already held being reused rather than duplicated.

**Done when:** green, and it fails if the creation loop is parallelised.

---

### T-12 · Dispatcher symbol and payload

**Phase:** P1
**Create:**

- `packages/agent/src/tasks/roster-provision.types.ts` —
  `RosterProvisionPayload { userId; organizationId: string | null; runId; blueprintSlug; lanes }`
- `packages/agent/src/tasks/roster-provision-dispatcher.ts` —
  `RosterProvisionDispatcher` interface with
  `dispatchRosterProvision(payload): Promise<string | null>` and
  `export const ROSTER_PROVISION_DISPATCHER = Symbol('ROSTER_PROVISION_DISPATCHER');`

Copy the file shape of `packages/agent/src/tasks/template-customization-dispatcher.ts`
exactly — one types file, one dispatcher file, no imports beyond the payload type.

**Done when:** both files compile with zero runtime imports.

---

### T-13 · Register the dispatcher (three pin lists — a missed one fails CI)

**Phase:** P1
**Modify:**

- `packages/agent/src/tasks/index.ts` — two export lines.
- `packages/agent/src/tasks/_tasks-symbols.ts` — add
  `'ROSTER_PROVISION_DISPATCHER'` in **alphabetical** position, with a one-line
  comment naming this epic, per the ritual its own header documents.
- `packages/agent/src/tasks/job-runtime.providers.ts` — import the symbol, add it
  to `DISPATCHER_SYMBOLS`, and update the **three** places the JSDoc says
  "11": the `DISPATCHER_SYMBOLS` doc, the `buildJobRuntimeProviders` arity note,
  and the `BuildJobRuntimeProvidersOptions.symbols` note.

**Modify (tests):**

- `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts` — arity pin
  `11 → 12`, plus an assertion that `ROSTER_PROVISION_DISPATCHER` resolves to the
  active provider's dispatchers view.
- `packages/agent/src/tasks/tasks.spec.ts` — no code change needed; confirm it
  re-counts from `_tasks-symbols.ts` and is green.

**Done when:** `cd packages/agent && pnpm test` is green and
`packages/tasks/src/trigger/trigger.module.ts` is **not** edited — the twelfth
symbol binds automatically through `...buildJobRuntimeProviders()`.

---

### T-14 · The background task and its dispatch method

**Phase:** P1
**Create:** `packages/tasks/src/tasks/trigger/roster-provision.task.ts`

`task({ id: 'roster-provision', maxDuration: 180 })`, booting the transient Nest
context the sibling tasks in this folder use, resolving `RosterProvisioningService`
and calling `execute(payload.runId, payload)`. Log with the Trigger SDK logger
(this file _does_ run inside a task — see the note in
`packages/tasks/src/dispatchers/workflow-run.dispatcher.ts` about which logger is
correct where).

**Modify:**

- `packages/tasks/src/tasks/trigger/index.ts` — one export line.
- `packages/tasks/src/trigger/trigger.service.ts` — add
  `dispatchRosterProvision(payload)` following `dispatchWorkGeneration` (line 413)
  exactly: `ensureConfigured()` guard returning `null`,
  `stampTenantOptions({ tags: ['roster-provision', payload.runId] })`,
  `idempotencyKey: payload.runId` so a double enqueue collapses to one run,
  return `handle.id`, `catch` → log and return `null`.

**Done when:** `pnpm build --filter=@ever-works/trigger-tasks` succeeds and no
file outside `packages/tasks/` imports `@trigger.dev/sdk` (Constitution IV).

---

### T-15 · Roster DTOs

**Phase:** P1
**Create:** `apps/api/src/onboarding/dto/onboarding-roster.dto.ts`

`ProvisionRosterLaneDto` and `ProvisionRosterDto` exactly as in
[plan.md §4.1](./plan.md#41-roster--appsapisrconboardingonboarding-rostercontrollerts),
plus the response DTOs `RosterBlueprintsResponseDto` and `RosterStateResponseDto`
with `@ApiProperty` decorations. Copy the `@IsIn(...)`-against-a-contracts-tuple
idiom from `apps/api/src/onboarding/dto/onboarding-state.dto.ts`.

**Done when:** a payload with an unknown lane key, a duplicate lane key, a missing
`coordination` lane, or 9 lanes is rejected by validation alone, with no service
code involved.

---

### T-16 · The roster controller

**Phase:** P1
**Create:** `apps/api/src/onboarding/onboarding-roster.controller.ts`

`@ApiTags('onboarding') @Controller('api/onboarding/roster')`, four routes per
[plan.md §4.1](./plan.md#41-roster--appsapisrconboardingonboarding-rostercontrollerts):

- `GET /blueprints` — catalogue plus the proposal derived from the caller's saved
  roles/team size (read them through `OnboardingStateService`, as
  `OnboardingSuggestionsController` already does).
  `@Throttle({ long: { limit: 60, ttl: 60_000 } })`
- `GET /` — current provisioning record (or `{ state: 'idle' }`) plus the caller's
  lane-holding agents.
- `POST /provision` — `@HttpCode(202)`. Mint `runId`, persist the record as
  `queued` under a compare-and-set so a concurrent request gets
  `409 roster_provision_in_flight`, then
  `@Inject(ROSTER_PROVISION_DISPATCHER)` `dispatchRosterProvision`. A `null`
  return records `failed` with `failureReason: 'unknown'`.
  `@Throttle({ long: { limit: 5, ttl: 3_600_000 } })`
- `POST /acknowledge` — idempotent; sets `rosterAcknowledgedAt`.

Refuse provisioning with `403` before any write when the caller cannot create
agents (FR-63).

**Modify:**

- `apps/api/src/onboarding/onboarding.module.ts` — register the controller and the
  new provider bindings. `AgentsModule` from `@ever-works/agent/agents` is already
  imported (see its comment at lines 17–20); do not import it twice.
- `apps/api/src/onboarding/dto/onboarding-telemetry.dto.ts` — append the **four
  roster events** from [plan.md §9.1](./plan.md#91-telemetry)
  (`onboarding_roster_blueprint_selected`, `onboarding_roster_provision_started`,
  `onboarding_roster_provision_finished`, `onboarding_roster_intro_viewed`) to
  `ONBOARDING_TELEMETRY_EVENTS`. The relay `@IsIn`-rejects anything else with a
  400, so a client-side event added without this edit is silently dropped at the
  API. The remaining five checklist events land in T-32.

**Done when:** every route appears in the OpenAPI document, the module boots, and
the four roster events validate.

---

### T-17 · Roster controller spec

**Phase:** P1
**Create:** `apps/api/src/onboarding/onboarding-roster.controller.spec.ts`

Cover: `202` with `state: 'queued'`; `409` when a run is in flight; `400` for each
of the four invalid payload shapes; `403` without permission and **no write**;
acknowledge is idempotent; throttle metadata reads 5 per 3 600 000 ms; a `null`
dispatcher result records `failed` rather than pretending success.

**Done when:** `cd apps/api && pnpm test` is green.

---

### T-18 · Wizard step registration

**Phase:** P1
**Modify:**

- `apps/web/src/components/onboarding/useOnboardingFlow.ts` — add `'roster'` to
  `WizardStepKind` and push `{ kind: 'roster', id: 'roster' }` in
  `computeStepList` **between** the `profile` push and the `communication` push.
  Add a comment in the file's existing voice explaining why it sits there.
- `apps/web/src/components/onboarding/EverWorksOnboardingWizard.tsx` — one
  `case 'roster'` render branch.
- `apps/web/src/components/onboarding/useOnboardingFlow.unit.spec.ts` — assert
  `roster` appears exactly once, immediately after `profile`, in every choice
  permutation, and that the list length grows by exactly one: **11** steps for
  `ONBOARDING_DEFAULT_STATE` (was 10) with `roster` at position 8, and **14**
  (was 13) with a non-default AI choice, `user-github` storage and `k8s` deploy,
  with `roster` at position 11.

Do **not** touch the reducer: the roster's own state lives in its component and
on the server, never in the wizard blob.

**Done when:** the header badge in
`apps/web/src/app/[locale]/(dashboard)/layout-client.tsx` shows the new total —
11 with every default choice, 14 with all three configuration steps — with no
edit to that file, because it calls the same `computeStepList`.

---

### T-19 · Server actions and API client for the roster

**Phase:** P1
**Create:** `apps/web/src/app/actions/onboarding/roster.ts`

`'use server'` wrappers `getRosterBlueprints`, `getRosterState`,
`provisionRoster`, `acknowledgeRoster`, each returning
`{ success, data?, error? }` rather than throwing — the shape
`apps/web/src/app/actions/onboarding/state.ts` already uses.

**Modify:** `apps/web/src/lib/api/onboarding.ts` — add the four matching methods
on `serverFetch` / `serverMutation`, keeping the file's `import 'server-only'`
posture.

**Done when:** `pnpm type-check` passes and no client component imports
`@/lib/api/onboarding` directly.

---

### T-20 · The roster step component

**Phase:** P1
**Create:**

- `apps/web/src/components/onboarding/steps/RosterStep.tsx`
- `apps/web/src/components/onboarding/steps/RosterStep.unit.spec.tsx`

Render spec §6.1 exactly: title, subtitle, one card per lane with an editable name
field, a `coordinator` chip and no **Remove** on lane 0, an **Add a lane** menu
capped at 8 with the documented disabled tooltip, the guardrail notice, and the
footer wired through the existing `WizardFooter`.

Keyboard per spec §6.1: `Tab` order, `Enter` commits a name, `Alt+A` opens the add
menu, `Ctrl/Cmd+Enter` is the primary action, `Esc` skips (confirming only when a
name was edited).

Read-only rendering with the "needs permission" notice when
`canCreateAgents === false`.

**Done when:** the Vitest spec covers name validation, the coordinator's missing
**Remove**, the add cap, and the read-only branch; and every string resolves
through `useTranslations('onboarding.rosterStep')`.

---

### T-21 · Progress panel and introduction

**Phase:** P1
**Create:**

- `apps/web/src/components/get-started/RosterProvisionProgress.tsx`
- `apps/web/src/components/get-started/RosterProvisionProgress.unit.spec.tsx`
- `apps/web/src/components/get-started/RosterIntroduction.tsx`

Progress panel renders spec §6.2 — the in-flight list, and all four result states
(ready, partial, failed, stalled). Poll `getRosterState` every **2 s** while the
state is `queued | creating | binding`; stop on a terminal state or after
**150 s** and show the stalled state. Announce transitions through a polite live
region.

Introduction renders spec §6.3, reusing the Headless UI dialog pattern from
`apps/web/src/components/dashboard/HelpDrawer.tsx`. `Esc` closes **without**
acknowledging; **Got it** calls `acknowledgeRoster`.

**Done when:** the spec asserts each outcome label, each result state, that
polling stops at a terminal state and at 150 s, and that `Esc` does not
acknowledge.

---

### T-22 · i18n — P1 keys

**Phase:** P1
**Modify:** `apps/web/messages/en.json`, then all 20 sibling locales

Add `onboarding.rosterStep.*`, `onboarding.provisioning.*` and
`onboarding.introduction.*` exactly as listed in
[plan.md §8.1–§8.3](./plan.md#8-i18n). Seed the other locales with
`node apps/web/scripts/sync-locale-parity.mjs` so full paths exist in every file —
a missing **parent** key collapses the whole subtree at runtime.

**Done when:** every locale file contains all three parents, no leaf name contains
a literal `.`, and `cd apps/web && pnpm test` (which includes the hydration
console-error check) is green.

---

### T-23 · P1 end-to-end

**Phase:** P1
**Create:**

- `apps/web/e2e/onboarding-roster-provisioning.spec.ts` — the golden path: the
  step appears in the wizard, provisioning runs, every lane reports a terminal
  outcome, the introduction lists every agent with its lane and reporting line,
  **Got it** closes it.
- `apps/web/e2e/onboarding-roster-idempotent.spec.ts` — provision twice; exactly
  one set of agents exists; the second run reports **Reused** for every lane.

**Verify unchanged:** `apps/web/e2e/flow-onboarding-wizard.spec.ts`,
`onboarding-wizard-v2.spec.ts`, `flow-onboarding-catalog-choices.spec.ts`,
`onboarding-communication-connect.spec.ts`, `tour-onboarding-replay.spec.ts` all
still pass with **no edits** — that is the additive-only proof.

**Done when:** `cd apps/web && pnpm test:e2e` is green for the new and the
pre-existing onboarding specs.

---

## Phase 2 — The checklist

Ships: the five milestones evaluated server-side, the **Get set up** card on Home,
the `/get-started` page, and the guided first task, first decision and first
schedule.

---

### T-24 · Entity — `OnboardingChecklist`

**Phase:** P2
**Create:** `packages/agent/src/entities/onboarding-checklist.entity.ts`

Implement exactly [plan.md §3.2](./plan.md#32-new-entity--onboardingchecklist):
uuid PK; `userId` (uuid, not null, **no** `@ManyToOne` — same cycle-avoidance
posture as `onboarding-request.entity.ts`); `organizationId` nullable;
`scopeKey` `varchar(64)` not null written in `@BeforeInsert`/`@BeforeUpdate` as
`organizationId ?? 'personal'`; `milestones` and `provisioning` as `simple-json`;
the four nullable timestamps; `@CreateDateColumn`/`@UpdateDateColumn`.

Declare the unique index `uq_onboarding_checklist_user_scope` on
`(userId, scopeKey)` and `idx_onboarding_checklist_user` on `(userId)`.

The doc comment must explain the `scopeKey` trick (SQL's NULL-is-distinct
semantics, the same dodge `Agent.scopeTargetId` uses) so a later reader does not
"simplify" it away.

---

### T-25 · Entity registration (four files — a drift spec fails CI if any is missed)

**Phase:** P2
**Modify:**

- `packages/agent/src/entities/index.ts` — barrel export
- `packages/agent/src/database/_entity-names.ts` — `'OnboardingChecklist'` in
  alphabetical position
- `packages/agent/src/database/_entities-inventory.ts` — import + entry in
  `ENTITIES`
- `packages/agent/src/database/_repository-inventory.ts` — the repository from
  T-26 in `REPOSITORY_PROVIDERS`, plus a barrel line in
  `packages/agent/src/database/index.ts`

**Done when:** `packages/agent/src/database/database.module.spec.ts` passes
without being edited to accommodate a missing entry.

---

### T-26 · Repository

**Phase:** P2
**Create:** `packages/agent/src/database/repositories/onboarding-checklist.repository.ts`

Model it on
`packages/agent/src/database/repositories/organization-onboarding-profile.repository.ts`:
`findForScope(userId, organizationId)`, `ensureForScope(...)` (find-or-create),
field-level `patch(...)` that leaves omitted fields alone, and
`compareAndSetProvisioningState(id, from, to)` returning a boolean — the
compare-and-set FR-16 relies on. No list, no delete.

**Done when:** two concurrent `compareAndSet` calls from the same `from` state
produce exactly one `true`.

---

### T-27 · Migration — `onboarding_checklists`

**Phase:** P2
**Create:** `apps/api/src/migrations/1791200100000-CreateOnboardingChecklists.ts`

`hasTable` guard → `createTable` with the columns and both indexes from
[plan.md §3.2](./plan.md#32-new-entity--onboardingchecklist). `simple-json`
columns are spelled `text` (portable across Postgres and the better-sqlite3 CLI
driver — the note the existing
`1784750000000-CreateOrganizationOnboardingProfiles.ts` already makes). No
foreign key to `users`, matching the entity's no-`@ManyToOne` posture. `down()`
drops the table.

**Done when:** the migration applies on a fresh database, is a no-op on a second
run, and `down()` leaves no orphan index.

---

### T-28 · Checklist DTOs and the starter catalogues

**Phase:** P2
**Create:**

- `apps/api/src/onboarding/dto/onboarding-checklist.dto.ts` —
  `SkipMilestoneDto` (`@IsIn(ONBOARDING_MILESTONES)`), `StarterTaskDto`
  (`briefId?`, `customBrief?` with `@MaxLength(10_000)`, `laneKey`),
  `StarterScheduleDto` (`@IsIn(['dailyDigest','weeklyReview','coordinatorCadence'])`),
  and the response DTOs from
  [plan.md §4.2](./plan.md#42-checklist--appsapisrconboardingonboarding-checklistcontrollerts).
- `apps/api/src/onboarding/starter-briefs.catalog.ts` — a frozen array of exactly
  **3** entries, each `{ id, laneKey, titleKey, bodyKey, doneWhenKey }`,
  each body under **280** characters. The catalogue holds i18n **keys**, not
  English text: the rendered copy lives in `en.json`. `doneWhenKey` resolves to
  the brief's "finished =" sentence and is appended to the Task's `description`;
  it is **not** written to `Task.acceptanceChecks`, which is a runnable command
  gate rather than prose.

**Done when:** a spec asserts the catalogue has exactly 3 entries, each under 280
characters when resolved against `en.json`, and each `laneKey` in
`ROSTER_LANE_KEYS`.

---

### T-29 · The checklist service

**Phase:** P2
**Create:** `apps/api/src/onboarding/onboarding-checklist.service.ts`

- `getOrCreate(userId, organizationId)` — lazy creation on first read (FR-43).
- `evaluate(...)` — the five reads from
  [plan.md §4.5](./plan.md#45-milestone-evaluation) in one `Promise.allSettled`;
  a rejected read sets `unknown: true` and leaves the milestone `pending`
  (FR-59); results cached for **60 s** on `evaluatedAt` and bypassed after any
  mutation (FR-38).
- `skip` / `unskip` / `hide` / `show` / `dismiss` — all idempotent.
- `startStarterTask(...)` — the five ordered steps in
  [plan.md §4.3](./plan.md#43-the-starter-task), creating exactly **one Task**
  and no Mission, **keeping** the Task when assignment fails and reporting
  `dispatched: false`.
- `armStarterSchedule(...)` — the three options in
  [plan.md §4.4](./plan.md#44-the-starter-schedule), each through the platform's
  existing mechanism for that kind of work — two recurring Tasks and one Agent
  heartbeat cadence. No new scheduling mechanism, and no Mission.

Never write a milestone to `done` from a client-supplied value (FR-36).

---

### T-30 · The checklist controller

**Phase:** P2
**Create:** `apps/api/src/onboarding/onboarding-checklist.controller.ts`

`@ApiTags('onboarding') @Controller('api/onboarding/checklist')` with the eight
routes from [plan.md §4.2](./plan.md#42-checklist--appsapisrconboardingonboarding-checklistcontrollerts),
each with the documented `@Throttle` and
`@Header('Cache-Control', 'private, no-store')` on the read.

**Modify:** `apps/api/src/onboarding/onboarding.module.ts` — register the
controller and the service.

**Done when:** every route is in the OpenAPI document and the module boots.

---

### T-31 · Checklist specs

**Phase:** P2
**Create:**

- `apps/api/src/onboarding/onboarding-checklist.controller.spec.ts` — lazy row
  creation on first read; skip/unskip changing the denominator; hide/show/dismiss
  transitions; `private, no-store`; the starter-task handler creating exactly one
  Task and no Mission, assigning it, and keeping the Task when assignment fails;
  the 10 000-character rejection; each of the three schedule options arming.
- `apps/api/src/onboarding/onboarding-checklist.service.spec.ts` — each milestone
  flipping only on its documented fact; a rejected read yielding `unknown` and
  never `done`; the 60 s cache honoured and bypassed after a mutation; an
  already-set-up account evaluating to complete **without creating anything**
  (FR-44).

**Done when:** `cd apps/api && pnpm test` is green.

---

### T-32 · Telemetry allow-list — the checklist events

**Phase:** P2
**Modify:** `apps/api/src/onboarding/dto/onboarding-telemetry.dto.ts`

Append the **five remaining** events from [plan.md §9.1](./plan.md#91-telemetry)
— `onboarding_checklist_viewed`, `onboarding_checklist_milestone_completed`,
`onboarding_checklist_milestone_skipped`, `onboarding_checklist_hidden`,
`onboarding_first_hour_completed` — to `ONBOARDING_TELEMETRY_EVENTS` (T-16 added
the four roster events).

**Create:** `apps/api/src/onboarding/dto/onboarding-telemetry.dto.spec.ts` —
mirrors `onboarding-state.dto.spec.ts`: all nine new events validate, an unlisted
event is rejected, and a property object containing a PostHog `$`-key is
stripped.

**Done when:** green, and no event name emitted anywhere in the web code is
absent from the tuple.

---

### T-33 · Route constant and layout wiring

**Phase:** P2
**Modify:**

- `apps/web/src/lib/constants.ts` — `DASHBOARD_GET_STARTED: '/get-started'` in the
  `ROUTES` block with a one-line comment naming the epic, matching the file's
  existing commenting style.
- `apps/web/src/app/[locale]/(dashboard)/layout.tsx` — one more promise in the
  existing `Promise.all`: `onboardingAPI.getChecklist().catch(() => null)`,
  passed down as `initialChecklist`.
- `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx` — thread
  `initialChecklist` to the home client and add the Help-drawer entry.
- `apps/web/src/components/dashboard/HelpDrawer.tsx` — one entry,
  **Set up Ever Works**, calling `showChecklist` then navigating to
  `/get-started`.

**Done when:** no new round trip is added after first paint, and a failing
checklist read leaves every other block on the dashboard untouched.

---

### T-34 · Server actions and API client for the checklist

**Phase:** P2
**Create:** `apps/web/src/app/actions/onboarding/checklist.ts`

`'use server'` wrappers for all eight routes, returning
`{ success, data?, error? }`.

**Modify:** `apps/web/src/lib/api/onboarding.ts` — the eight matching methods.

---

### T-35 · The Home card

**Phase:** P2
**Create:**

- `apps/web/src/components/get-started/SetupChecklistCard.tsx`
- `apps/web/src/components/get-started/MilestoneRow.tsx`
- `apps/web/src/components/get-started/SetupChecklistCard.unit.spec.tsx`

**Modify:** `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx` —
mount the card at the top of the existing stack. Render nothing when the payload
is `null`, `hidden`, or `dismissed`. Do not reorder or remove any existing block.

Render every state in spec §6.4: loading skeleton at row height with no layout
shift, error, one-skipped, completed, and blocked-on-an-admin. Reuse
`apps/web/src/components/common/EmptyState.tsx` where an empty state is needed
rather than adding a bespoke one.

**Done when:** the spec covers counter arithmetic with skips, the error state, the
completed state, and that the card renders nothing when hidden or dismissed.

---

### T-36 · The `/get-started` page

**Phase:** P2
**Create:**

- `apps/web/src/app/[locale]/(dashboard)/get-started/page.tsx`
- `apps/web/src/app/[locale]/(dashboard)/get-started/get-started-client.tsx`
- `apps/web/src/components/get-started/SetupChecklistPanel.tsx`
- `apps/web/src/components/get-started/StarterBriefPicker.tsx`
- `apps/web/src/components/get-started/StarterBriefPicker.unit.spec.tsx`
- `apps/web/src/components/get-started/StarterSchedulePicker.tsx`

Render spec §6.5 in full, including the no-roster, no-provider and over-limit
states. The 60-second refresh must pause while any field has focus or unsaved
input (FR-39). Radio groups are single tab stops with arrow-key selection;
`Ctrl/Cmd+Enter` inside a section triggers that section's primary action.

**Done when:** the picker spec covers the 10 000-character counter and trim
message, and the no-provider warning still allows sending.

---

### T-37 · The standalone roster dialog

**Phase:** P2
**Create:** `apps/web/src/components/get-started/RosterSetupDialog.tsx`

Hosts `RosterStep` and `RosterProvisionProgress` outside the wizard (spec §6.6):
**Skip for now** becomes **Cancel**, **Continue setup** becomes **Close**.
Nothing else differs — it must not fork the step's logic.

**Done when:** milestone 2's **Set up my agents** action opens it from both the
card and the page, and the wizard step's own spec still passes unchanged.

---

### T-38 · i18n — P2 keys

**Phase:** P2
**Modify:** `apps/web/messages/en.json`, then all 20 sibling locales

Add `dashboard.getSetUp.*` (including `milestones.*` and `briefs.*`) exactly as
listed in [plan.md §8.4](./plan.md#84-dashboardgetsetup--the-card-and-the-page),
plus `metadata.pages.getStarted` and
`dashboard.header.help.setUpEverWorks`. Seed the sibling locales with
`node apps/web/scripts/sync-locale-parity.mjs`.

**Done when:** every locale file has the full `dashboard.getSetUp` subtree, no
leaf name contains a literal `.`, and the three starter-brief bodies are each
under 280 characters in English.

---

### T-39 · P2 end-to-end

**Phase:** P2
**Create:**

- `apps/web/e2e/onboarding-first-hour-checklist.spec.ts` — the card renders on
  Home with the right count; skip and undo; hide and reopen from Help; the
  `/get-started` page renders every section.
- `apps/web/e2e/onboarding-first-task.spec.ts` — picking a brief creates exactly
  one Task, assigns it to the lane agent, and links to it.

**Done when:** `cd apps/web && pnpm test:e2e` is green.

---

## Phase 3 — Repair and reach

Ships: recovery from a partial run, blueprint switching, and a second person's
first hour on an existing workspace.

---

### T-40 · Per-lane repair

**Phase:** P3
**Modify:**

- `packages/agent/src/agents/roster-provisioning.service.ts` — accept an optional
  `laneKeys` filter so a repair run attempts only the named lanes.
- `apps/api/src/onboarding/dto/onboarding-roster.dto.ts` — `ProvisionRosterDto`
  gains an optional `repairOnly: boolean`.
- `apps/web/src/components/get-started/RosterProvisionProgress.tsx` — a
  **Finish setting up** action on a partial result that re-provisions only the
  outstanding lanes.

**Create:** `apps/web/e2e/onboarding-roster-partial.spec.ts` — a partial run
renders the plans link, and **Finish setting up** attempts only the missing lanes
and leaves the existing agents untouched.

---

### T-41 · Blueprint switching (add-only)

**Phase:** P3
**Modify:** `apps/web/src/components/get-started/SetupChecklistPanel.tsx` and the
roster controller

Allow choosing a different blueprint after the fact. It may only **add** lanes:
switching never archives, pauses or renames an agent that may already have been
given work (spec §9, open question).

**Done when:** a spec asserts that no existing agent is modified by a blueprint
switch beyond gaining a collaborator row.

---

### T-42 · Second-person checklist on an existing workspace

**Phase:** P3
**Modify:** `apps/api/src/onboarding/onboarding-checklist.service.ts`

For a person joining a workspace that already has a roster, evaluate milestone 2
against the workspace's existing lane-holding agents and offer the introduction
rather than provisioning. Milestone 2's action becomes **Meet the agents**, and
the "waiting on an admin" state (FR-63) applies when they cannot create agents.

**Done when:** a spec covers a member with and without agent-create permission,
and neither path creates a duplicate roster.

---

### T-43 · Completion funnel

**Phase:** P3
**Modify:** the web components emitting telemetry

Emit `onboarding_first_hour_completed` exactly once per checklist, with
`minutesSinceSignup` and `skippedCount`. Guard on `completedAt` transitioning
from null so a refresh cannot double-count.

**Done when:** a spec asserts the event fires once across two renders of a
completed checklist.

---

### T-44 · Documentation

**Phase:** P3
**Modify:**

- `docs/specs/features/agent-workspace/TRACKER.md` — mark AW-20 spec/plan/tasks
  complete and record the implementation status per phase, including the capabilities
  this epic delivers.
- `docs/specs/features/agent-workspace/README.md` §1 — add **lane** to the
  vocabulary table as an attribute of Agent, per program rule #2, in the same PR
  that lands T-08.

**Done when:** no other doc claims a different roster or checklist model.

---

## Task index

| #    | Task                                            | Phase | Kind      |
| ---- | ----------------------------------------------- | ----- | --------- |
| T-01 | Contracts: roster vocabulary                    | P1    | create    |
| T-02 | Contracts: first-hour vocabulary                | P1    | create    |
| T-03 | Contracts: barrel exports                       | P1    | modify    |
| T-04 | The coordinator agent template                  | P1    | modify    |
| T-05 | The blueprint catalogue                         | P1    | create    |
| T-06 | Blueprint catalogue spec                        | P1    | test      |
| T-07 | Extend the agent-template integrity suite       | P1    | test      |
| T-08 | `lane` on the Agent entity and DTOs             | P1    | modify    |
| T-09 | Migration — `agents.lane`                       | P1    | migration |
| T-10 | The provisioning service                        | P1    | create    |
| T-11 | Provisioning service spec                       | P1    | test      |
| T-12 | Dispatcher symbol and payload                   | P1    | create    |
| T-13 | Register the dispatcher (three pin lists)       | P1    | modify    |
| T-14 | The background task and its dispatch method     | P1    | create    |
| T-15 | Roster DTOs                                     | P1    | create    |
| T-16 | The roster controller                           | P1    | create    |
| T-17 | Roster controller spec                          | P1    | test      |
| T-18 | Wizard step registration                        | P1    | modify    |
| T-19 | Server actions and API client for the roster    | P1    | create    |
| T-20 | The roster step component                       | P1    | create    |
| T-21 | Progress panel and introduction                 | P1    | create    |
| T-22 | i18n — P1 keys                                  | P1    | i18n      |
| T-23 | P1 end-to-end                                   | P1    | test      |
| T-24 | Entity — `OnboardingChecklist`                  | P2    | create    |
| T-25 | Entity registration (four files)                | P2    | modify    |
| T-26 | Repository                                      | P2    | create    |
| T-27 | Migration — `onboarding_checklists`             | P2    | migration |
| T-28 | Checklist DTOs and the starter catalogues       | P2    | create    |
| T-29 | The checklist service                           | P2    | create    |
| T-30 | The checklist controller                        | P2    | create    |
| T-31 | Checklist specs                                 | P2    | test      |
| T-32 | Telemetry allow-list — the checklist events     | P2    | modify    |
| T-33 | Route constant and layout wiring                | P2    | modify    |
| T-34 | Server actions and API client for the checklist | P2    | create    |
| T-35 | The Home card                                   | P2    | create    |
| T-36 | The `/get-started` page                         | P2    | create    |
| T-37 | The standalone roster dialog                    | P2    | create    |
| T-38 | i18n — P2 keys                                  | P2    | i18n      |
| T-39 | P2 end-to-end                                   | P2    | test      |
| T-40 | Per-lane repair                                 | P3    | modify    |
| T-41 | Blueprint switching (add-only)                  | P3    | modify    |
| T-42 | Second-person checklist                         | P3    | modify    |
| T-43 | Completion funnel                               | P3    | modify    |
| T-44 | Documentation                                   | P3    | docs      |

**44 tasks · P1 = T-01…T-23 · P2 = T-24…T-39 · P3 = T-40…T-44.**
</content>
