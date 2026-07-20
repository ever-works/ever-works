# Domain-model evolution — Execution Plan

**Owner:** Engineering · **Created:** 2026-07-19 · **Sibling spec:** [spec.md](spec.md)

> Per-PR file-level plan for the ladder defined in [spec.md §2](spec.md). Each PR is its own branch
> off `develop`, own conventional-commit history, own branch-E2E dispatch (require 2 consecutive
> green), merged independently.

---

## §0. Cross-cutting rules (read before any rung)

1. **Every new entity MUST be registered in the `ENTITIES` array** in
   `packages/agent/src/database/database.config.ts`. There is no `autoLoadEntities`; a
   `forFeature`'d-but-unregistered entity throws `EntityMetadataNotFoundError` → unmapped 500 on
   every query (known bug class).
2. **Every entity/schema change ships its migration in the SAME PR**
   (`docs/specs/architecture/database-migrations.md`). Migrations live in
   `apps/api/src/migrations/`, are idempotent (`hasTable`/name-checked-index guards,
   `ON CONFLICT DO NOTHING` backfills), and the API self-applies them on boot.
3. **New required boot env vars are forbidden without deploy wiring** in the same PR
   (`.github` workflows + k8s manifests + GH secret) — the `PLATFORM_ENCRYPTION_KEY` silent-outage
   lesson. None of the ladder's PRs should need one.
4. **Facade errors map to 4xx via `FacadeExceptionFilter`** by stable `.name` — new failure modes
   in services get a `FacadeError` subclass, not a bare throw (prod redacts messages; Server
   Actions return discriminated unions, never branch on thrown `err.message`).
5. **Broad status/contract flips must reconcile `apps/web/e2e`** — grep the touched endpoints for
   both exact `toBe(...)` assertions and tolerance arrays (`[200, 500].includes`), and remember
   the tsc gate: `apps/web/tsconfig.json` type-checks e2e specs.
6. Prettier root config (tabs w4, single quotes, no trailing commas); kebab-case filenames;
   `.github`/`.deploy` YAML is NOT in the prettier glob.

## §1. Migration-timestamp allocation

TypeORM orders migrations by the numeric timestamp prefix. Allocation for this ladder:

| Slot            | Owner                                          | Status                  |
| --------------- | ---------------------------------------------- | ----------------------- |
| `1781500000000` | **Unmerged Teams/prebuilt-companies branch**   | RESERVED — do not use   |
| `1781600000000` | PR-1 `CreateIdeaWorksTable`                    | **TAKEN (this branch)** |
| `1781700000000` | PR-2 `CreateMissionWorksTable`                 | allocated               |
| `1781800000000` | PR-3 `AddMissionOutcomeColumns`                | allocated               |
| `1781900000000` | PR-4 `ResetStrandedQueuedIdeas` (data-only)    | allocated               |
| `1782000000000` | PR-5 `RenameWorkAgentGoalsToWorkBuildRequests` | allocated               |
| `1782100000000` | PR-6 `AddOrganizationVision`                   | allocated               |
| `1782200000000` | PR-8 `CreateGoalsTables`                       | allocated               |

Rules: PR-7, PR-9, PR-10 ship **no** migrations. If `develop` gains a migration newer than an
allocated slot before that rung merges, re-slot the rung forward (keep ordering monotonic vs.
merged history); never renumber an already-merged migration. New unrelated work takes slots
**after** `1782200000000`.

## §2. PR-1 — `idea_works` provenance (THIS branch, implemented)

| Layer      | Files                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entity     | `packages/agent/src/entities/idea-work.entity.ts` (+ `ENTITIES` registration in `database.config.ts`, export from entities index)                                                                                  |
| Migration  | `apps/api/src/migrations/1781600000000-CreateIdeaWorksTable.ts` (create + Backfill A `kind='linked'` + Backfill B `acceptedFromIdeaId` stamp)                                                                      |
| Repository | `packages/agent/src/database/repositories/idea-work.repository.ts` (`recordLink` orIgnore, `listForIdeaWithWork`, `listForWork`, `countForIdea`); provided/exported from `user-research.module.ts`                 |
| Service    | `packages/agent/src/user-research/work-proposal.service.ts` — `acceptInternal(userId, proposalId, workId, fromStatuses, opts?: { linkKind })` + `recordProvenance`; `handleGoalCompletion` → `'built'`/`'rebuilt'` |
| API        | `apps/api/src/work-proposals/work-proposals.controller.ts` — accept `fromStatuses` `[PENDING, ACCEPTED]`; NEW `GET /api/me/work-proposals/:id/works`                                                               |
| UI         | none in PR-1 (Idea detail "Linked Works" panel rides a follow-up; the route is UI-ready)                                                                                                                           |
| Docs       | this spec/plan pair + erratum note in `../missions-ideas-works/spec.md` §1.2                                                                                                                                       |

**Tests**: agent Jest — accept-path IDOR guard, link-kind first-writer-wins, `acceptedFromIdeaId`
never overwritten, re-accept appends + re-points (`packages/agent/src/user-research/__tests__/`);
API Jest — 404-for-foreign-Idea on `GET :id/works`, second accept from ACCEPTED; e2e — accept an
Idea twice against two Works, assert `links.length === 2` newest-first and card CTA points at
newest.

## §3. PR-2 — `mission_works` M:N

| Layer      | Files                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity     | `packages/agent/src/entities/mission-work.entity.ts` — `missionId`/`workId` FKs CASCADE, `kind: created\|improves\|operates\|markets\|researches\|retires`, unique (`missionId`,`workId`,`kind`), Tier C scope columns; register in `ENTITIES` |
| Migration  | `1781700000000-CreateMissionWorksTable.ts` + backfill `kind='created'` from existing Mission→Idea→`idea_works` chains                                                                                                                          |
| Repository | `packages/agent/src/database/repositories/mission-work.repository.ts` (record orIgnore, list per Mission with Work fields, list per Work, detach non-`created` kinds)                                                                          |
| Service    | Mission service: attach/detach guarded same-owner; Idea fan-out records `created` on build success                                                                                                                                             |
| API        | `apps/api/src/missions/` — `GET /me/missions/:id/works`, `POST /me/missions/:id/works` (attach existing, kind ≠ `created`), `DELETE /me/missions/:id/works/:linkId` (non-`created` only)                                                       |
| UI         | Mission detail Works panel: attach-existing-Work picker + kind badge (`apps/web/src/app/[locale]/(dashboard)/missions/[id]/`, `apps/web/src/components/missions/`)                                                                             |
| e2e        | attach/detach flows, `created` rows immutable via API, Mission delete leaves Works intact                                                                                                                                                      |

**Tests**: unit — `created` append-only (detach of `created` rejected), CASCADE removes links not
Works; e2e as above.

## §4. PR-3 — Mission outcome + FAILED writer + activity log

| Layer     | Files                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity    | `packages/agent/src/entities/mission.entity.ts` — nullable `outcome` (`succeeded\|partially_succeeded\|failed\|cancelled\|superseded`), `completedAt`                                           |
| Migration | `1781800000000-AddMissionOutcomeColumns.ts` (add columns, no backfill — old completed Missions keep NULL outcome)                                                                               |
| Service   | Mission complete action accepts optional outcome + stamps `completedAt`; tick worker gains terminal-failure → `FAILED` writer; revive action FAILED → active                                    |
| API       | `apps/api/src/missions/` — complete body gains `outcome?`; `POST :id/revive`                                                                                                                    |
| Activity  | `apps/api/src/activity-log/` + agent events — new actions `mission.completed` (with outcome), `mission.failed`, `mission.revived`, `idea.accepted`, `idea.built`, `idea.rebuilt`, `idea.linked` |
| UI        | Complete dialog outcome picker; FAILED banner + Revive button; timeline renders new actions                                                                                                     |
| Chat/MCP  | **Deliberate no-op**: verify no complete-Mission tool exists in `apps/web/src/lib/ai/tools/` nor `apps/mcp/src/openapi-tools/whitelist.ts`; add a guard test                                    |

**Tests**: unit — outcome only on complete path, tick worker writes FAILED only on terminal
classification, revive resets; e2e — complete-with-outcome, revive-from-FAILED; guard test that
chat/MCP toolsets contain no Mission-complete verb.

## §5. PR-4 — Build-executor wiring (flagged) + stranded-QUEUED reset

- Feature flag (config/env read via existing config module, default **off**) gating the executor
  that drains `QUEUED` Ideas into build requests.
- Migration `1781900000000-ResetStrandedQueuedIdeas.ts` — data-only: `QUEUED` → `PENDING`
  (Option A ruling); idempotent by construction.
- Guard: queueing endpoint rejects (mapped 4xx) when the executor flag is off, so the UI cannot
  strand new Ideas; UI hides Queue action under the same flag.
- Retry path **reuses the existing Run/build-request record** (spec invariant 5) — no new request
  row per retry.

**Tests**: unit — reset touches only QUEUED, guard 4xx when flag off, retry-reuses-Run; e2e —
adaptive (flag off in CI): queue action hidden/rejected, no stranded state.

## §6. PR-5 — Rename `work_agent_goals` → `work_build_requests`

- Migration `1782000000000-RenameWorkAgentGoalsToWorkBuildRequests.ts` — table rename + FK/index
  renames (rename, never drop/create — data preserved).
- Entity `work-agent-goal.entity.ts` → `work-build-request.entity.ts`, class `WorkAgentGoal` →
  `WorkBuildRequest`; grep ALL call sites (`packages/agent`, `apps/api/src/work-agent/`,
  `apps/web/src/lib/api/work-agent.ts`, trigger tasks) — the lazy-plugin-proxy lesson: partial
  renames fail at runtime, not compile time, wherever strings name the table.
- API routes stay URL-stable where externally consumed; internal DTO/type names + UI copy
  ("Goal" → "Build request") change. MCP whitelist entries re-checked.

**Tests**: type-check is the main gate (`pnpm type-check`); agent Jest suites re-run untouched;
e2e — grep `apps/web/e2e` for `goal` against work-agent surfaces and update copy assertions.

## §7. PR-6 — `organizations.vision`

- Entity: `organization.entity.ts` + migration `1782100000000-AddOrganizationVision.ts`
  (nullable text).
- API: `apps/api/src/organizations/` create/update DTOs gain `vision?` (validated length-capped).
- Prompt injection: the generation/agent prompt assembly points that already receive org context
  append vision when non-empty — **injection-safe**: rendered as data inside the existing prompt
  scaffold, never as instructions from an untrusted channel.
- UI: org creation flow field + settings section.

**Tests**: unit — prompt assembly with/without vision; e2e — set vision in settings, assert
round-trip; snapshot of prompt fragment.

## §8. PR-7 — `metrics-provider` capability + custom-http + Stripe

- Contract: `packages/plugin/src/contracts/capabilities/metrics-provider.interface.ts`
  (`IMetricsProviderPlugin`: `listMetrics()`, `fetchSamples(metricId, range)`).
- Facade: `packages/agent/src/facades/` metrics facade (tolerate-undefined on lazy-plugin proxy —
  known over-report gotcha).
- Plugins: `packages/plugins/everworks-custom-http-metrics/` (**GET-only**, response schema
  validated, SSRF-guarded via the existing egress guards) and `packages/plugins/stripe-metrics/`
  (official `stripe` SDK — vendor-SDK rule, no hand-rolled fetch).
- No migrations.

**Tests**: Vitest per plugin (mocked transports; GET-only enforcement test; SSRF/localhost
rejection test); contract tests in `packages/plugin`.

## §9. PR-8 — Goal entity + samples + `mission_goals` + dispatcher + UI

- Entities (+ `ENTITIES` registration): `goal.entity.ts` (metric ref, target, direction,
  timeframe, nullable `outcome`), `goal-metric-sample.entity.ts` (append-only),
  `mission-goal.entity.ts` (M:N, unique pair). Migration `1782200000000-CreateGoalsTables.ts`.
- Dispatcher: scheduled evaluation (existing BullMQ/trigger scheduling pattern à la
  `workScheduleDispatcherTask`) pulls samples via the PR-7 facade, evaluates targets, **may**
  auto-set Goal `outcome` (human-overridable). **Never writes `missions.outcome`** — add a guard
  test.
- API: `apps/api/src/` goals module — CRUD, attach/detach Mission, samples read.
- UI: `/goals` list + detail + attach-to-Mission picker; Mission detail Goals panel.

**Tests**: unit — evaluation math (direction/timeframe edges), auto-set + human-override
precedence, no-Mission-outcome-write guard; e2e — create Goal with custom-http provider stubbed,
attach to Mission, list samples.

## §10. PR-9 — PostHog + GA providers + Goal prompt integration

- `packages/plugins/posthog-metrics/`, `packages/plugins/google-analytics-metrics/` (official
  vendor SDKs).
- Mission tick prompt assembly includes attached Goals (current vs. target) — data-injection only,
  same safety posture as PR-6.
- No migrations.

**Tests**: Vitest per plugin (mocked SDKs); unit — tick prompt fragment with/without Goals.

## §11. PR-10 — Remove `/discover`

- Delete `apps/web/src/app/[locale]/(dashboard)/discover/` (page.tsx + discover-client.tsx); sweep
  remaining internal links (`WorkProposalsSection.tsx`, `IdeasPageClient.tsx`, `IdeaCard.tsx`,
  onboarding `PluginsCatalogStep.tsx`, `lib/api/work-proposals.ts`, locale files).
- Keep `WorkProposalSource.DISCOVER` enum value (historical rows).
- Docs sweep: remove `/discover` mentions from `docs/` + `apps/docs` sidebar if listed.

**Tests**: e2e — `/discover` 404s (env-adaptive: next-dev vs prod-web `.or()` pattern if needed);
grep-gate that no nav link renders it; existing Ideas-page specs stay green.

## §12. Rollout / sequencing

- Strict order only where stated: PR-5 and PR-7 before PR-8; PR-8 before PR-9. PR-2/3/4/6/10 are
  order-free relative to each other.
- Every rung: `pnpm type-check` + affected package tests + ONE branch-E2E dispatch (poll; require
  two consecutive green before merge — `cancel-in-progress` gotcha).
- Review doc PR #1684 merges after the ladder (its §16–§23 then match shipped reality), followed by
  the develop → stage → main cascade.
