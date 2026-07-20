# Feature Specification: Domain-model evolution

**Feature ID**: `domain-model-evolution`
**Branch**: `feat/idea-works-provenance` (PR-1; each later rung of the ladder ships on its own branch)
**Status**: `Draft`
**Created**: 2026-07-19
**Last updated**: 2026-07-19
**Owner**: Product (Ruslan)

**Related code today**:

- Idea↔Work provenance entity: `packages/agent/src/entities/idea-work.entity.ts` (this branch)
- Provenance repository: `packages/agent/src/database/repositories/idea-work.repository.ts` (this branch)
- Migration: `apps/api/src/migrations/1781600000000-CreateIdeaWorksTable.ts` (this branch)
- Accept flow: `packages/agent/src/user-research/work-proposal.service.ts` (`acceptInternal`, `recordProvenance`)
- API surface: `apps/api/src/work-proposals/work-proposals.controller.ts` (`POST :id/accept`, `GET :id/works`)
- Existing entities touched later: `packages/agent/src/entities/mission.entity.ts`, `work-agent-goal.entity.ts`, `organization.entity.ts`, `work.entity.ts`

> **Source of the rulings**: `docs/architecture/domain-model-review.md` §16–§23 — the full domain-model
> review. That document arrives via PR #1684 (unmerged at the time of writing); until it lands, this
> spec is the merged summary of its rulings. ADR numbers cited below (e.g. **ADR-009**) refer to that
> review's **internal** decision series — they are NOT the `docs/specs/decisions/NNN-*.md` ADR series
> (review ADR-009 = "1 Idea → 0..N Works"; `decisions/009-tasks-vs-items-vs-kb-distinction.md` is an
> unrelated document that happens to share the number).
>
> **Hard rule (additive by default)**: per [Workspace AGENTS.md NN #20], everything here is an
> extension unless the review explicitly ruled a removal or rename. The two explicit exceptions are
> PR-5 (rename `work_agent_goals` → `work_build_requests`) and PR-10 (removal of `/discover`) — both
> operator-ruled.

---

## 1. Goal

Implement the ruled changes of the domain-model review as a ladder of small, independently mergeable
PRs. The review's core findings:

1. The Idea → Work relationship was speced 1:1 ("1 Idea → 1 Work. Always.",
   [missions-ideas-works spec §1.2](../missions-ideas-works/spec.md)) but the product reality and the
   operator ruling is **0..N** — one Idea can legitimately spawn a mobile-app Work AND a website
   Work, and a done Idea can be re-built. A single `acceptedWorkId` pointer cannot represent that.
2. Missions relate to Works in many ways (created it, improves it, operates it…) but must never
   **own** them — Works are top-level and outlive any Mission.
3. "Goal" is an overloaded term: `work_agent_goals` (build requests) collides with the upcoming
   metric-backed Goal concept.
4. Mission completion needs an **outcome** dimension without a status-machine rewrite.
5. Organizations need a `vision` that feeds generation prompts; Goals need pluggable metric sources.

A registered erratum in [missions-ideas-works spec §1.2](../missions-ideas-works/spec.md) points the
old 1:1 passage at this spec.

## 2. Scope — the PR ladder

| PR    | Title                                                              | Schema                                                | Status          |
| ----- | ------------------------------------------------------------------ | ----------------------------------------------------- | --------------- |
| PR-1  | `idea_works` provenance (authoritative 0..N Idea→Work)             | `idea_works` (new) + 2 backfills                      | **THIS BRANCH** |
| PR-2  | `mission_works` M:N relation + attach existing Work                | `mission_works` (new)                                 | planned         |
| PR-3  | Mission outcome-at-Complete + FAILED writer + activity-log verbs   | `missions.outcome`, `missions.completedAt`            | planned         |
| PR-4  | Idea build-executor wiring (feature-flagged) + stranded-QUEUED fix | data-only (QUEUED→PENDING reset)                      | planned         |
| PR-5  | Rename `work_agent_goals` → `work_build_requests` (frees "Goal")   | table + column renames                                | planned         |
| PR-6  | `organizations.vision` + creation-flow field + prompt injection    | `organizations.vision`                                | planned         |
| PR-7  | `metrics-provider` plugin capability + custom-http + Stripe        | none (plugin contract)                                | planned         |
| PR-8  | Goal entity + samples + `mission_goals` + evaluation dispatcher    | `goals`, `goal_metric_samples`, `mission_goals` (new) | planned         |
| PR-9  | PostHog + Google Analytics providers + Goal prompt integration     | none                                                  | planned         |
| PR-10 | Remove `/discover` (redirect already gone → route removed)         | none                                                  | planned         |

Each PR is independently mergeable and independently revertible; later rungs depend on earlier ones
only where stated (PR-8 needs PR-5's freed "Goal" name and PR-7's capability; PR-9 needs PR-7/8).

## 3. PR-1 — `idea_works` provenance (implemented on this branch)

Ruling: review §23.1 / **ADR-009** — _"From one Idea, 0..N Works can be spawned."_ The `idea_works`
table is the **authoritative** Idea↔Work relation. `WorkProposal.acceptedWorkId` is retained as a
denormalized "primary / most-recent" pointer for list-card CTAs and API back-compat.

### 3.1 Entity / table

`idea_works` (`packages/agent/src/entities/idea-work.entity.ts`):

| Column           | Type          | Notes                                                      |
| ---------------- | ------------- | ---------------------------------------------------------- |
| `id`             | uuid PK       | generated                                                  |
| `ideaId`         | uuid FK       | → `work_proposals.id`, `ON DELETE CASCADE`                 |
| `workId`         | uuid FK       | → `works.id`, `ON DELETE CASCADE`                          |
| `userId`         | uuid FK       | → `users.id`, `ON DELETE CASCADE`; always the Idea's owner |
| `kind`           | varchar(16)   | `'built' \| 'linked' \| 'rebuilt'`                         |
| `tenantId`       | uuid nullable | EW-655 Tier C denormalized scope, stamped by subscriber    |
| `organizationId` | uuid nullable | same                                                       |
| `createdAt`      | timestamp     |                                                            |

Indexes: `uq_idea_work` UNIQUE on (`ideaId`, `workId`); `idx_idea_works_work` on (`workId`).
No `@ManyToOne` on the scope columns (entities import-cycle rule).

**Kind semantics**:

- `linked` — user accepted the Idea against an existing Work (`POST /me/work-proposals/:id/accept`),
  or the row was seeded by the backfill (conservative default — pre-existing links cannot be
  reliably classified).
- `built` — the build pipeline created the Work from this Idea (goal-completion success path, first
  build).
- `rebuilt` — a Re-build of an already-accepted Idea produced this Work. The previous link row is
  kept — history is append-only.

### 3.2 Relationship contract

- 1 Idea → **0..N** Works (`idea_works` rows, authoritative).
- 1 Work → **at most 1** source Idea: `works.acceptedFromIdeaId`, stamped **first-writer-wins** on
  first link and never overwritten afterwards.
- `WorkProposal.acceptedWorkId` = denormalized primary pointer; each successful accept **re-points
  it at the newest** linked Work.
- Rows are **append-only** in application code: recorded, never updated or deleted. They disappear
  only via DB CASCADE when the Idea, the Work, or the owning User is deleted.
- `recordLink` uses `INSERT … ON CONFLICT DO NOTHING` (`orIgnore`) — idempotent from both the
  user-accept and goal-completion paths; the per-pair `kind` is therefore first-writer-wins (a
  re-accept of an already-`built` pair does not downgrade it to `linked`).

### 3.3 Service behavior

`WorkProposalService.acceptInternal(userId, proposalId, workId, fromStatuses, opts?)`:

1. IDOR guard — proposal AND Work must both belong to `userId`.
2. `markAccepted` — status → `ACCEPTED`, `acceptedWorkId` → `workId` (re-point at newest).
3. Record an `idea_works` link with `opts.linkKind ?? 'linked'`.
4. Stamp `works.acceptedFromIdeaId = proposalId` **only if currently NULL** (first-writer-wins).

`handleGoalCompletion` success path records the link with kind `'built'` (first build) or
`'rebuilt'` (Re-build of a done Idea).

### 3.4 API surface

- `POST /api/me/work-proposals/:id/accept` `{ workId }` — `fromStatuses` widened to
  `[PENDING, ACCEPTED]`: the first accept links from PENDING; accepting an **already-accepted** Idea
  links an ADDITIONAL Work and re-points `acceptedWorkId` at the newest. Existing endpoint,
  additive widening only.
- `GET /api/me/work-proposals/:id/works` — **NEW**. Returns
  `{ links: [{ id, ideaId, workId, kind, createdAt, workName, workSlug }] }`, newest first;
  `workName`/`workSlug` are `null` if the Work row vanished mid-query (CASCADE race). `404` when the
  Idea does not exist for the authenticated user.

### 3.5 Migration + backfill

`1781600000000-CreateIdeaWorksTable` — idempotent (`hasTable`-guarded create, name-checked indexes,
`ON CONFLICT DO NOTHING` seeding, NULL-filtered stamping):

- **Backfill A** — one `idea_works` row per existing `work_proposals.acceptedWorkId`,
  `kind = 'linked'` (review §17 Phase 2c: no kinds are invented). Inner-joins `works` to skip
  dangling pointers.
- **Backfill B** — repairs the dead reverse pointer (review finding P1): stamps
  `works.acceptedFromIdeaId` from the Idea side wherever it is still NULL.
- `down()` drops the table only; Backfill B's stamped values are correct data on a pre-existing
  column and are left in place.

## 4. PR-2 — `mission_works` M:N relation

Ruling: Missions **relate to** Works; they never **own** them. New `mission_works` join table:
`missionId` (FK `missions` CASCADE), `workId` (FK `works` CASCADE), plus a `kind` describing the
relation:

`created | improves | operates | markets | researches | retires`

- `created` is provenance (the Mission's Idea fan-out produced this Work) — append-only like
  `idea_works`.
- The other kinds describe an ongoing relationship and may be attached/detached by the user
  ("Attach existing Work" action on the Mission detail page).
- Deleting a Mission deletes its `mission_works` **rows** (CASCADE) — never the Works.
- A Work may relate to many Missions; a Mission to many Works. Unique per
  (`missionId`, `workId`, `kind`).

## 5. PR-3 — Mission outcome-at-Complete + activity-log verbs

Ruling: no status-machine rewrite. When a user completes a Mission, `status` stays `'completed'`;
two new optional columns capture the _how it ended_:

- `outcome`: `succeeded | partially_succeeded | failed | cancelled | superseded` (nullable — old
  completed Missions simply have none).
- `completedAt`: timestamp.

Rules:

- **Human-only**: Complete (and its outcome) is a human UI/API action. Autonomous agent runs never
  get a "complete the Mission" tool — not in web-chat tools, not in the MCP whitelist.
- `FAILED` gains a **tick-worker writer**: a Mission whose scheduled ticks keep failing terminally
  may be marked FAILED by the tick worker. FAILED is **revivable** — the user can move it back to
  active.
- Mission/Idea **activity-log actions**: `mission.completed` (with outcome), `mission.failed`,
  `mission.revived`, `idea.accepted`, `idea.built`, `idea.rebuilt`, `idea.linked` recorded through
  the existing `activity-log` module. Additive — no existing action changes.

## 6. PR-4 — Idea build-executor wiring (flagged)

The Ideas UI can put an Idea into `QUEUED`, but on some deployments no executor drains the queue —
Ideas strand forever. Ruling (**Option A**):

- Wire the build executor behind a feature flag (default off until validated per environment).
- Where the executor is not enabled, **stranded QUEUED Ideas are reset to `PENDING`** (one-time
  data migration + a guard so the UI cannot queue into a dead queue). No Idea is dismissed or
  failed by this reset — it simply returns to the actionable pool.

## 7. PR-5 — Rename `work_agent_goals` → `work_build_requests`

The `work_agent_goals` table holds **build requests** ("build a Work from this Idea"), not goals.
Renaming frees the word "Goal" for the metric-backed Goal entity (PR-8) before it ships:

- Table rename + FK/index renames; entity `WorkAgentGoal` → `WorkBuildRequest`; API DTO/route copy
  updated; UI copy "Goal" → "Build request" on Work-Agent surfaces.
- Pure rename: no behavior change, no column semantics change. `WorkAgentRun` /
  `WorkAgentRunLog` / `WorkAgentPreference` keep their names (they are not overloaded).

## 8. PR-6 — `organizations.vision` + prompt injection

- New nullable text column `organizations.vision` ("what this organization is trying to become").
- Creation flow gains an optional Vision field; Organization settings gains an editable Vision
  section.
- Prompt injection: generation and agent pipelines that already receive organization context
  include the vision (when set) in their system prompts, so Works/Ideas/Missions produced under an
  org lean toward its vision. Additive — empty vision = today's behavior.

## 9. PR-7..9 — Goals + `metrics-provider` plugin capability

The "Goal" freed by PR-5 becomes a first-class, **metric-backed** target.

- **PR-7 — capability + first providers**: new `metrics-provider` plugin capability
  (`IMetricsProviderPlugin`): a provider exposes named metrics and returns time-stamped numeric
  samples. First-party providers: **Stripe** (revenue/MRR-style metrics) and **custom HTTP**
  (user-configured **GET-only** endpoint returning a number — no mutating verbs, ever).
- **PR-8 — Goal entity + evaluation**: `goals` (name, metric ref, target value, direction,
  timeframe, `outcome` nullable), `goal_metric_samples` (append-only samples pulled from
  providers), `mission_goals` (M:N attach — a Goal can drive several Missions; a Mission can serve
  several Goals). An **evaluation dispatcher** (scheduled) pulls samples and evaluates targets.
  Goals UI (list + detail + attach-to-Mission).
- **PR-9 — more providers + prompt integration**: **PostHog** and **Google Analytics** providers;
  attached Goals (current value vs. target) injected into Mission tick prompts.

Rulings:

- **Goal outcome MAY be auto-set** from its metric (target reached → `succeeded`, timeframe expired
  short → `failed`), always human-overridable.
- **Mission outcome is NEVER auto-set** — not from Goals, not from metrics. Human-only (PR-3 rule).
- Custom HTTP metrics are **GET-only** and response-validated; a metrics provider can never be used
  as a webhook/mutation channel.

## 10. PR-10 — Remove `/discover`

The `/discover` dashboard route (`apps/web/src/app/[locale]/(dashboard)/discover/`) is dead — the
redirect into it is already gone. Operator-ruled removal (explicit exception to the additive
default): delete the route + client component, remove remaining internal links, update docs. The
`WorkProposalSource.DISCOVER` enum value **stays** (historical rows reference it).

## 11. Invariants (the ladder's laws)

1. **Works are never Mission-owned.** `mission_works` is a relation; deleting a Mission never
   deletes a Work. Works stay top-level and outlive everything that points at them.
2. **Provenance is permanent and append-only.** `idea_works` rows and `mission_works` rows of kind
   `created` are never updated or deleted by application code; only DB CASCADE (entity deletion)
   removes them. Rebuilds append; they never rewrite history.
3. **`acceptedWorkId` is denormalized, never authoritative.** It always equals the newest
   `idea_works` link for that Idea; every consumer that needs the full picture reads `idea_works`.
4. **`works.acceptedFromIdeaId` is first-writer-wins.** Stamped once, never overwritten — a Work
   keeps its original source Idea even if later re-linked.
5. **Retry reuses the Run.** Retrying a failed Idea build re-drives the existing build
   request/Run record — no duplicate request rows for one logical build; attempt history stays
   attached to one Run.
6. **Mission outcome is human-only; Goal outcome may be machine-set.** No agent tool and no
   dispatcher ever writes `missions.outcome`.
7. **Teams = structure.** Teams group people and agents; they never become owners of Missions,
   Ideas, or Works, and never become an execution primitive.
8. **Additive by default** (Workspace NN #20). Removal/rename only where explicitly ruled: PR-5
   rename, PR-10 `/discover` removal.

## 12. Non-goals

- No change to Work runtime behavior, generation pipelines, or deploy targets.
- No merge/unification of Tasks, Items, or KB (per `decisions/009-tasks-vs-items-vs-kb-distinction.md`).
- No Mission status-machine rewrite (outcome is a new column, not new states).
- No write-capable metric providers, and no automated money movement of any kind.
- No backfill of `kind` beyond the conservative `linked` default — history is not invented.

## 13. References

- `docs/architecture/domain-model-review.md` §16–§23 (PR #1684 — source of the rulings, incl.
  review ADR-009)
- [missions-ideas-works spec](../missions-ideas-works/spec.md) — §1.2 carries the registered
  erratum pointing here
- [missions-ideas-works plan](../missions-ideas-works/plan.md) — Decision Log A1–A28
- Sibling execution plan: [plan.md](plan.md)
