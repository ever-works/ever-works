# Implementation Plan: Community PR Processing

**Feature ID**: `community-pr-processing`
**Spec**: `./spec.md`
**Tasks**: `./tasks.md`
**Status**: `Done` (retrospective — surface already shipped)
**Last updated**: 2026-05-08

---

## 1. Architecture

```mermaid
flowchart TD
    Cron["@Cron(EVERY_HOUR)<br/>CommunityPrSchedulerService"] -->|outer lock<br/>works:community-pr-scheduler<br/>TTL 1h| AllWorks
    Controller["POST /api/works/:id/process-community-prs<br/>WorksController.processCommunityPrs"] -->|owner gate +<br/>communityPrEnabled| ProcessOne
    AllWorks[CommunityPrProcessorService.processAllWorks<br/>'schedule'] -->|for each enabled work| ProcessOne[CommunityPrProcessorService.processWork]

    ProcessOne -->|per-work lock<br/>community-pr:&lt;workId&gt;<br/>TTL 30m| List
    List[GitFacade.listPullRequests<br/>state=open, perPage=100] --> Filter[isPrHandled<br/>processedPrs.updatedAt match<br/>else processedPrNumbers]
    Filter --> Loop[For each unprocessed PR]
    Loop --> Files[GitFacade.getPullRequestFiles]
    Files --> Context[Build changeContext<br/>cap MAX_CHANGE_CONTEXT_LENGTH=50000]
    Context --> Clone[GitFacade.cloneOrPull dataRepo]
    Clone --> Categories[DataRepository.getCategories<br/>fallback empty array]
    Categories --> AI[AiFacade.askJson<br/>extractedItemSchema<br/>temperature=0.3]
    AI -->|items=[]| Ignored[outcome='ignored']
    AI -->|items=N| Slugs[slugifyText + dedup<br/>seenSlugs + data.itemExists]
    Slugs --> Write[data.writeItem + writeItemMarkdown]
    Write --> Push[GitFacade.add/commit/push]
    Push --> History[recordCommunityPrHistory<br/>WorkGenerationHistoryRepository]
    History --> Comment[GitFacade.createPullRequestComment]
    Comment --> AutoClose[GitFacade.closePullRequest<br/>if autoClose=true]

    Loop --> MarkPr[markPrHandled<br/>processedPrNumbers + processedPrs<br/>FIFO 500 cap]
    MarkPr --> StateWrite[workRepository.update communityPrState]
    StateWrite --> Increment[workRepository.increment itemsCount<br/>only if itemsAdded > 0]
    Controller --> ActivityLog[activityLogService.log<br/>COMMUNITY_PR_MERGED<br/>fire-and-forget]
```

## 2. Tech Choices

| Concern              | Choice                                                                                              | Rationale                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mutual exclusion     | `DistributedTaskLockService.runExclusive` (Postgres-backed advisory locks)                          | Principle IV. Outer scheduler lock + per-work lock; the same primitive used across all schedulers in `apps/api/src/works/tasks/`.                                  |
| Trigger surface      | Cron (hourly) + manual POST endpoint                                                                | Hourly is the right cadence for community contributions; the manual endpoint lets owners drain a queue without waiting for the next tick.                         |
| GitHub access        | `GitFacadeService` (resolves provider plugin from `work.gitProvider`)                               | Principle II. Switching to GitLab / Bitbucket is a plugin swap, not a service rewrite.                                                                              |
| AI extraction        | `AiFacadeService.askJson(prompt, zodSchema, options, context)`                                      | Provider-agnostic; the work's plugin settings determine which AI provider runs. `temperature: 0.3` keeps output deterministic.                                     |
| Output schema        | `zod` (`extractedItemSchema`)                                                                       | Schema validation built-in; bad responses throw and the per-PR `try/catch` records `lastError`.                                                                     |
| State persistence    | `work.communityPrState` jsonb (additive column on `works`)                                          | Single-row update per `processWork` call; no separate state table; survives `Work` lifecycle.                                                                        |
| History writes       | `WorkGenerationHistoryRepository.createEntry({activityType: COMMUNITY_PR_MERGED, ...})`             | Reuses the existing per-work generation timeline. Fire-and-forget so DB hiccups don't lose data already pushed to git.                                              |
| Audit log emission   | Controller path emits `activity_logs` row; service path does NOT                                    | Matches the convention across `WorksController` — service layer is reusable from cron / Trigger.dev where there's no `auth.userId`. Audit is a controller concern. |
| Slug dedup           | Set + `DataRepository.itemExists(slug)` check                                                       | Two-layer dedup: within-run (`Set<string>`) and across-runs (`itemExists` reads the data repo).                                                                      |
| Context truncation   | Hard cap at 50 000 chars before AI prompt is built                                                  | LLM context windows + cost; large diffs are usually formatting-only PRs that don't add new items anyway.                                                            |

## 3. Data Model

### Entities

- `Work.communityPrState` — additive jsonb column.
  `{processedPrNumbers: number[]; processedPrs?: Array<{number, updatedAt, outcome}>; lastProcessedAt?: string; totalItemsAdded?: number; lastError?: string | null}`.
  Pre-existing rows load with `null`; the code falls back to
  `{processedPrNumbers: [], totalItemsAdded: 0}`.
- `Work.communityPrEnabled` — boolean gate.
- `Work.communityPrAutoClose` — boolean (close PR after merge).
- `WorkGenerationHistory` — used to record each successful run;
  `activityType: COMMUNITY_PR_MERGED`, `status: GENERATED`,
  `triggeredBy` ∈ `{user, schedule, api}`.

### DTOs / contracts

- `CommunityPrProcessingResult` — `{processed: number; errors: Array<{workId, error}>}`. The aggregate return shape from `processAllWorks`.
- `CommunityPrSinglePrResult` — `{outcome: 'applied' | 'ignored'; itemsAdded: number}`. Per-PR contract.
- `CommunityPrTriggerSource` — `'user' | 'schedule' | 'api'`.

### Migrations

- The `communityPrState` jsonb column already shipped via prior
  migrations (see `packages/agent/src/database/migrations/`).
  This feature does NOT add new schema.

## 4. API Surface

| Method | Endpoint                                          | Auth                                  | Description                                                          | Status  |
| ------ | ------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- | ------- |
| `POST` | `/api/works/:id/process-community-prs`            | Global `AuthSessionGuard` + owner gate | Manually drain pending community PRs; returns `{itemsAdded}`. | Shipped |

(Note: the endpoint path uses dashes-not-slashes —
`process-community-prs` — and the controller method is
`processCommunityPrs`. The original spec listed
`/api/works/:id/community-pr/process` which is incorrect.)

## 5. Plugin Surface

None new. The integration consumes:

- **AI provider plugin** (any) via `aiFacade.askJson` with
  `{userId, workId}` context. Plugin is selected by the work's
  configured AI provider in plugin-settings.
- **Git provider plugin** (`github` today) via `gitFacade.*`.

## 6. Web / CLI Surface

- **Web**: a "Process community PRs" button on the work detail
  page maps to the manual `POST /api/works/:id/process-community-prs`
  endpoint. The status indicator reads
  `work.communityPrState.lastProcessedAt` / `lastError` /
  `totalItemsAdded` to render history.
- **CLI**: not explicitly wired today; could be added by calling
  the API endpoint with a session token.

## 7. Background Jobs

`CommunityPrSchedulerService` at
`apps/api/src/works/tasks/community-pr-scheduler.service.ts`:

- `@Cron(CronExpression.EVERY_HOUR)` decorator.
- Outer lock via
  `runExclusive('works:community-pr-scheduler', fn, {ttlMs: 60*60*1000, onLocked: ...})`.
- Calls `communityPrProcessor.processAllWorks()` (defaults
  `triggeredBy: 'schedule'`).
- Try/catch wraps the inner call; errors surface as
  `logger.error('Error during community PR processing', stack)`
  and DO NOT propagate (the cron is fire-and-forget).

The processor itself is NOT a Trigger.dev task today — it runs
in-process inside the API's Nest scheduler. A future enhancement
could move heavy works to Trigger.dev for replay / retry / observability
benefits.

## 8. Security & Permissions

- **Manual trigger** (`processCommunityPrs` in `WorksController`):
  - Caller MUST be authenticated (global `AuthSessionGuard`).
  - Caller MUST have access to the work (`workQueryService.getWork(id, user)`
    enforces ownership / membership).
  - Work MUST have `communityPrEnabled === true`
    (`BadRequestException` otherwise).
- **Scheduler trigger**: server-side; no user context. Uses the
  work owner's GitHub tokens via the plugin-settings store.
- **Token handling**: tokens are fetched lazily by `gitFacade.*`
  via the work-scoped plugin context (`{userId: work.userId, providerId, workId: work.id}`).
  They are never logged.
- **Rate limiting**: there is no API-level rate limit on the
  manual endpoint today; the per-work lock is the only safeguard
  against abuse. Future hardening could add `@Throttle` decorators.

## 9. Observability

- **`work_generation_history`** rows for each successful PR
  application:
    - `activityType: COMMUNITY_PR_MERGED`
    - `status: GENERATED`
    - `triggeredBy` from caller
    - `newItemsCount: entries.length`
    - `changelog: buildWorkChangelog(entries, "Community PR #N merged: M item(s) added")`
- **`activity_logs`** rows emitted ONLY by the controller path:
    - `actionType: COMMUNITY_PR_MERGED`
    - `action: 'community_pr.processed'`
    - `status: COMPLETED`
    - `summary: 'Processed community PRs'`
    - `details: {itemsAdded}`
- **Logger**:
    - `Failed to process work <id>: <msg>` (error)
    - `Failed to process PR #<n> for work <id>: <msg>` (error)
    - `Skipping community PR processing for work <id> because another instance is already processing it` (debug)
    - `Skipping community PR item "<name>" for work <id> because slug "<slug>" already exists` (warn)
    - `Community PR #<n> for work <id> was applied but commenting failed: <msg>` (warn)
    - `Community PR #<n> for work <id> was applied but auto-close failed: <msg>` (warn)
    - `Community PR #<n> for work <id> was applied but history recording failed: <msg>` (warn)
    - `Starting community PR processing` (log) [scheduler]
    - `Community PR processing completed: <n> processed, <m> errors` (log) [scheduler]
- **Metrics**: standard Nest request-duration histograms cover
  the manual endpoint. The scheduler does not export per-run
  metrics today.

## 10. Phased Rollout

Shipped. The feature is gated per-work via `communityPrEnabled`,
so works without explicit opt-in are unaffected. The hourly
scheduler is global; if it ever needs to be paused, the cron can
be disabled via `@nestjs/schedule`'s dynamic-cron API or by
removing `CommunityPrSchedulerService` from the works module.

## 11. Risks & Mitigations

| Risk                                                                                                       | Likelihood | Impact                                                  | Mitigation                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-work lock TTL (30m) expires mid-run on a slow work                                                     | Low        | A second replica may pick up the same work               | The scheduler's outer lock prevents that across replicas. For single-replica deploys, the in-memory `Set` of processed slugs prevents within-batch duplicates.                                       |
| AI extraction returns plausible-but-wrong items                                                            | Medium     | Junk items added to the work                            | `temperature: 0.3` + zod schema; the data repo is a git repo, so a maintainer can revert the commit. Future: review queue (OQ-3 in `tasks.md`).                                                       |
| GitHub rate limit hit mid-batch                                                                            | Low        | Run aborts; some PRs unprocessed                        | Per-PR try/catch records `lastError`; unprocessed PRs are picked up next hour. State is persisted at end-of-work, so progress is not lost beyond the in-flight PR.                                    |
| Duplicate slugs across PRs land items in different file-paths                                              | Low        | One PR's item silently shadows another's                | `data.itemExists(slug)` reads the live filesystem; the second-arriving PR is skipped + logged. This is intentional — first-write-wins.                                                                  |
| `recordCommunityPrHistory` fails after items pushed                                                        | Low        | History row missing for a successful run               | Caught + warn-logged; items remain in repo. A reconciliation job could backfill from git history (OQ-3).                                                                                                |
| `processedPrNumbers` array unboundedly grows                                                               | High       | jsonb row balloons over years of operation              | 500-entry FIFO eviction on both `processedPrNumbers` and `processedPrs` arrays. Old PRs may be re-processed if they're still open and their numbers are evicted; `itemExists(slug)` blocks duplicate items in that case. |
| Comment / auto-close fails after merge                                                                     | Medium     | PR contributor sees no acknowledgement                  | Caught + warn-logged; the merge is still durable. Owner can manually comment if needed.                                                                                                                  |
| Manual endpoint has no rate limit                                                                          | Low        | Owner spams the endpoint                                | The per-work lock makes back-to-back calls effectively a no-op (subsequent calls see no unprocessed PRs); not exploitable. Future: `@Throttle({short: {limit: 5, ttl: 60_000}})`.                       |
| Schedule cron doesn't run                                                                                  | Low        | Community PRs sit unprocessed                            | The manual endpoint is the operator's escape hatch. Future: alarm on `lastProcessedAt < now - 6h` for any `communityPrEnabled` work.                                                                     |

## 12. Constitution Reconciliation

See `spec.md` §9.

## 13. References

- Spec: `./spec.md`
- Tasks: `./tasks.md`
- Implementation:
    - `packages/agent/src/community-pr/community-pr-processor.service.ts`
    - `apps/api/src/works/tasks/community-pr-scheduler.service.ts`
    - `apps/api/src/works/works.controller.ts` (`processCommunityPrs`)
- Lock service:
  `packages/agent/src/cache/distributed-task-lock.service.ts`
- Tests:
    - `packages/agent/src/community-pr/__tests__/`
    - `apps/api/src/works/tasks/community-pr-scheduler.service.spec.ts`
    - `apps/api/src/works/works.controller.comparisons-misc.spec.ts`
- Related specs:
    - [`scheduled-updates`](../scheduled-updates/spec.md)
    - [`activity-log`](../activity-log/spec.md)
    - [`work-changelog`](../work-changelog/spec.md)
    - [`creating-a-work`](../creating-a-work/spec.md)
