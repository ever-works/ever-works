# Feature Specification: Community PR Processing

**Feature ID**: `community-pr-processing`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

When community members open Pull Requests against a work's main repo
(typically adding new items to an Awesome-List-style README), the
platform discovers the open PRs, extracts new items via the work's
configured AI provider, writes those items to the work's separate
**data repo** (NOT the PR's own repo), commits + pushes, records the
event in `work_generation_history`, comments back on the PR, and
optionally auto-closes processed PRs.

Two trigger paths consume the same `CommunityPrProcessorService`:

1. **Manual** — `POST /api/works/:id/process-community-prs` from
   `WorksController` (gated by `communityPrEnabled`, owner-only).
2. **Scheduled** — `CommunityPrSchedulerService.handleCommunityPrProcessing`
   runs hourly via `@Cron(CronExpression.EVERY_HOUR)` and processes
   every work that has `communityPrEnabled = true`.

Per-work mutual exclusion is enforced via
`DistributedTaskLockService.runExclusive` keyed by
`community-pr:<workId>` with a 30-minute TTL. The scheduler also
holds an outer lock keyed `works:community-pr-scheduler` (1 hour
TTL) so only one replica runs the cron at any time.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** my work has `communityPrEnabled=true` and open community
  PRs against the main repo, **when** the hourly scheduler runs OR I
  click "Process community PRs" in the dashboard, **then** the
  processor reads each open PR, extracts new items via AI, writes
  them to the data repo, commits + pushes, comments on the PR, and
  (if `communityPrAutoClose=true`) closes it.
- **Given** my work's data repo already contains an item with the
  same slug as a proposed addition, **when** the per-PR loop reaches
  that slug, **then** the duplicate is silently skipped (with a
  `logger.warn`); the rest of the PR's items continue.
- **Given** a PR has already been processed (its `number` is in
  `state.processedPrNumbers` AND its `updatedAt` matches the entry
  in `state.processedPrs`), **when** the next run looks at it,
  **then** it is skipped — no double-processing.
- **Given** a PR was previously processed but the contributor has
  since pushed new commits (changing `pr.updatedAt`), **when** the
  next run looks at it, **then** the processor RE-processes the PR
  from scratch — the `processedPrs` record's `updatedAt` mismatch
  triggers re-extraction.

### 2.2 Edge cases & failures

- **Given** another worker is already processing the same work's
  PRs (per-work `community-pr:<workId>` lock held), **when** my
  worker tries, **then** `runExclusive` returns
  `{acquired: false, result: undefined}` and the service returns
  `0` (no items added) — the lock-holder's `onLocked` log fires.
- **Given** the AI extraction returns `{items: []}` (PR was just
  formatting changes / typo fixes / reorganisation), **when**
  `processSinglePr` reads the response, **then** the PR is marked
  with `outcome: 'ignored'` and the loop moves on — NO PR comment,
  NO items written, NO PR close.
- **Given** the diff context exceeds `MAX_CHANGE_CONTEXT_LENGTH`
  (50 000 chars), **when** the loop builds the AI prompt, **then**
  the truncation breaks at the last entry that fits — the prompt
  never exceeds the cap, even if it means dropping later files.
- **Given** the AI's response fails the zod schema
  (`extractedItemSchema`), **when** `aiFacade.askJson` throws,
  **then** the per-PR `try/catch` records `lastError`, logs the
  stack via `this.logger.error`, and the loop continues with the
  NEXT PR — the failed PR is NOT marked processed (so it'll retry
  on the next run).
- **Given** the GitHub API throws on `listPullRequests` /
  `getPullRequestFiles` / `cloneOrPull`, **when** the per-PR loop
  catches it, **then** `currentState.lastError` is set to the
  message, the in-memory `processedPrs` is NOT updated for the
  failing PR, and processing continues.
- **Given** every PR in the batch fails AND no items were added,
  **when** the loop ends, **then** `currentState.lastProcessedAt`
  is still set to the new timestamp + `lastError` is set to the
  last failure; the work row is updated; `itemsCount` is NOT
  incremented (because `totalItemsAdded === 0`).
- **Given** all 500 entries of `processedPrNumbers` are already
  filled, **when** another PR is processed, **then** the array is
  sliced to keep only the LAST 500 (FIFO eviction). The
  `processedPrs` array follows the same rule independently.
- **Given** comment posting fails after items have been written
  AND pushed, **when** the comment call throws, **then** the
  exception is caught and surfaces as
  `logger.warn('Community PR #X for work Y was applied but commenting failed: ...')`
  — the items remain in the data repo and the PR is still marked
  `applied`.
- **Given** auto-close fails after items have been written AND
  pushed AND commented, **when** the close call throws, **then**
  the exception is caught and surfaces as
  `logger.warn('... was applied but auto-close failed: ...')` —
  the run still counts as `applied`.
- **Given** `recordCommunityPrHistory` throws (e.g. transient DB
  failure), **when** the per-PR loop catches it, **then** the
  failure is logged via `logger.warn` but the items remain in the
  data repo and the PR is still marked `applied` — history is
  best-effort, not transactional.
- **Given** the controller endpoint is hit on a work where
  `communityPrEnabled === false`, **when**
  `WorksController.processCommunityPrs` checks the gate, **then**
  it throws `BadRequestException('Community PR processing is not enabled for this work.')`.
- **Given** the controller endpoint is hit on a non-existent
  workId, **when** `workRepository.findById` returns `null`,
  **then** the controller throws
  `NotFoundException('Work not found')`.

## 3. Functional Requirements

- **FR-1** `CommunityPrProcessorService.processAllWorks(triggeredBy?)` MUST
  iterate every `Work` returned by `workRepository.findWithCommunityPrEnabled()`,
  call `processWork(work, state, autoClose, triggeredBy)` for each,
  and aggregate results into `{processed, errors:[]}`. Errors per
  work MUST NOT abort the loop — they are accumulated.

- **FR-2** Per-work exclusivity MUST be enforced via
  `DistributedTaskLockService.runExclusive` with key
  `community-pr:<workId>` and `ttlMs: 30 * 60 * 1000` (30 minutes).
  When the lock is held, `runExclusive` MUST emit the configured
  `onLocked` log line at `debug` and return
  `{acquired: false, result: undefined}` — `processWork` MUST
  surface this as `lockResult.result ?? 0`.

- **FR-3** PR discovery MUST use
  `gitFacade.listPullRequests(owner, mainRepo, {state:'open', perPage:100}, gitOptions)`
  with `gitOptions = {userId: work.userId, providerId: work.gitProvider, workId: work.id}`.
  When zero open PRs are returned, the function MUST return `0`
  WITHOUT updating `lastProcessedAt`.

- **FR-4** A PR MUST be considered "already handled" when EITHER
  (a) `state.processedPrs` contains an entry whose `number` matches
  the PR AND whose `updatedAt` matches the PR's `updatedAt`,
  OR (b) `state.processedPrs` does NOT contain a matching number
  AND `state.processedPrNumbers` does. This means PRs that were
  processed by an older code path (when `processedPrs` did not
  exist) remain skip-listed, while NEW updates (different
  `updatedAt`) trigger re-processing.

- **FR-5** When zero unprocessed PRs are found, `processWork` MUST
  return `0` WITHOUT updating `lastProcessedAt` (consistent with
  FR-3 — there's nothing to record).

- **FR-6** For each unprocessed open PR, the processor MUST:
    - Pull the PR's file changes via
      `gitFacade.getPullRequestFiles(owner, mainRepo, pr.number, gitOptions)`.
    - Build a change-context string by concatenating
      `--- <filename> (<status>) ---\n<patch>\n\n` for each file,
      breaking the loop the FIRST time the running length plus the
      next entry would exceed `MAX_CHANGE_CONTEXT_LENGTH` (50 000).
    - Short-circuit to `{outcome:'ignored', itemsAdded:0}` when
      `changeContext.trim()` is empty (no usable patches).
    - Clone-or-pull the work's data repo via
      `gitFacade.cloneOrPull({owner, repo: dataRepo}, gitOptions)`.
    - Read existing categories via `DataRepository.create(dest).getCategories()`
      (with a `.catch((): Category[] => [])` fallback to empty list).
    - Build the extraction prompt via `buildExtractionPrompt(...)`
      including `workName`, `workDescription`, `categories`,
      `prTitle`, `prBody`, and the truncated `prChanges`.
    - Call `aiFacade.askJson(prompt, extractedItemSchema, {temperature: 0.3}, {userId: work.userId, workId: work.id})`.
    - Iterate the resulting `items[]` array and for each, generate
      `slug = slugifyText(item.name)`. Items with empty slug, slugs
      already seen in this run (`seenSlugs.has(slug)`), or slugs
      already present in the data repo (`await data.itemExists(slug)`)
      MUST be silently skipped with a `logger.warn`.
    - For accepted items, call `data.createItemDir(itemData)`,
      `data.writeItem(itemData)`, and write a markdown file via
      `data.writeItemMarkdown(itemData, markdown)` where `markdown`
      is `# ${item.name}\n\n${item.description}\n\n[${item.source_url}](${item.source_url})`.
    - When zero items were added (all skipped or all duplicate),
      the PR MUST be marked `outcome: 'ignored'` and the function
      MUST return WITHOUT git commit / push / comment / close.
    - When ≥1 items are added, the processor MUST `gitFacade.add(provider, dest, '.')`,
      `gitFacade.commit(provider, dest, 'Add N item(s) from community PR #X')`,
      and `gitFacade.push({dir: dest}, gitOptions)`.

- **FR-7** When ≥1 items are added, the processor MUST
  fire-and-forget `recordCommunityPrHistory` to write a
  `WorkGenerationHistory` row with `status: GENERATED`,
  `activityType: WorkHistoryActivityType.COMMUNITY_PR_MERGED`,
  `triggeredBy` from the caller, `newItemsCount: entries.length`,
  and `changelog: buildWorkChangelog(entries, 'Community PR #N merged: M item(s) added')`.
  History-write failure MUST be caught + logged via `logger.warn`
  WITHOUT failing the run.

- **FR-8** When ≥1 items are added, the processor MUST attempt
  `gitFacade.createPullRequestComment(owner, mainRepo, pr.number, '<thank-you body with item list>', gitOptions)`.
  Comment failure MUST be caught + logged via `logger.warn`
  WITHOUT failing the run.

- **FR-9** When `autoClose === true` AND ≥1 items are added, the
  processor MUST attempt
  `gitFacade.closePullRequest(owner, mainRepo, pr.number, gitOptions)`.
  Close failure MUST be caught + logged via `logger.warn` WITHOUT
  failing the run. The auto-close gate uses the per-call `autoClose`
  argument when defined, falling back to `work.communityPrAutoClose`.

- **FR-10** After the per-PR loop ends, the processor MUST call
  `markPrHandled(state, pr, prResult.outcome)` for each PR that
  succeeded — adding the `pr.number` to `processedPrNumbers`,
  pushing `{number, updatedAt, outcome}` into `processedPrs`,
  and applying the 500-entry FIFO eviction to BOTH arrays.

- **FR-11** After the per-PR loop ends, the processor MUST update
  the work via `workRepository.update(work.id, {communityPrState: currentState})`.
  This write captures `lastProcessedAt: <ISO now>`,
  `lastError: <message or null>`, and
  `totalItemsAdded: <prev + thisRun>`. State persistence is
  per-WORK (per-`processWork` invocation), NOT per-PR.

- **FR-12** When the run added ≥1 items, the processor MUST also
  `workRepository.increment(work.id, 'itemsCount', totalItemsAdded)`
  so the cached items-count on the work entity reflects the new
  rows.

- **FR-13** The controller endpoint
  `POST /api/works/:id/process-community-prs` MUST:
    - Run owner-access gate via `workQueryService.getWork(id, user)`.
    - Throw `NotFoundException('Work not found')` when
      `workRepository.findById(id)` returns `null`.
    - Throw `BadRequestException('Community PR processing is not enabled for this work.')`
      when `work.communityPrEnabled === false`.
    - Call `communityPrProcessorService.processWork(work)` (no
      explicit `state` / `autoClose` / `triggeredBy` — the service
      defaults to the work's `communityPrAutoClose` and
      `triggeredBy: 'api'`).
    - Invalidate caches via `invalidateWorkCaches(id)`.
    - Fire-and-forget activity-log entry via
      `activityLogService.log({...}).catch(()=>{})` with
      `actionType: ActivityActionType.COMMUNITY_PR_MERGED`,
      `action: 'community_pr.processed'`,
      `status: ActivityStatus.COMPLETED`,
      `summary: 'Processed community PRs'`,
      `details: {itemsAdded}`.
    - Return `{itemsAdded}` envelope.

- **FR-14** `CommunityPrSchedulerService.handleCommunityPrProcessing`
  MUST be decorated with `@Cron(CronExpression.EVERY_HOUR)` and
  guarded by an outer `runExclusive` lock keyed
  `works:community-pr-scheduler` with `ttlMs: 60 * 60 * 1000`
  (1 hour). Errors during `processAllWorks()` MUST be caught and
  logged via `this.logger.error('Error during community PR processing', stack)`
  — the cron MUST NOT propagate the error.

- **FR-15** The trigger source value `triggeredBy` is one of
  `'user' | 'schedule' | 'api'`:
    - `'schedule'` — set by `CommunityPrSchedulerService.processAllWorks()`
      (the scheduler's default).
    - `'api'` — set by `CommunityPrProcessorService.processWork`
      when called without an explicit `triggeredBy` (i.e. the
      controller path).
    - `'user'` — reserved for direct user-driven runs (currently
      unused on `develop`; reserved for a future "run now" action
      against a specific PR).

## 4. Non-Functional Requirements

- **Performance**: a single processing run handles up to 100 open
  PRs per work per invocation (the `perPage: 100` cap on
  `listPullRequests`). The `MAX_CHANGE_CONTEXT_LENGTH` cap (50 000
  chars) keeps AI prompt size bounded. The data-repo clone is
  re-used across all PRs in a single `processWork` call —
  `cloneOrPull` is the slow path; subsequent operations on the
  same `dest` are local writes.
- **Reliability**: per-work mutex with 30-minute TTL prevents
  duplicate processing across replicas. The scheduler's outer
  lock (1-hour TTL) prevents thundering-herd cron runs. State
  persistence at the work level (after each `processWork`) means
  a process crash mid-batch loses ONLY the in-flight PR — already
  applied items remain in the data repo and the lock TTL releases
  the work for the next scheduled run.
- **Security**: PR processing uses the work owner's git tokens
  resolved via `gitFacade` from the configured git-provider plugin
  (typically the `github` plugin's OAuth token or the platform's
  GitHub App installation token). Tokens are never logged. The
  AI provider plugin is selected by the work's
  `aiFacade.askJson(prompt, schema, options, {userId, workId})`
  context — the work's plugin settings determine the provider.
- **Observability**:
    - Per-work outcome via `recordCommunityPrHistory` writes a
      `work_generation_history` row (`activityType: COMMUNITY_PR_MERGED`).
    - Controller path additionally emits an `activity_logs` row
      (`actionType: COMMUNITY_PR_MERGED`, `action: 'community_pr.processed'`).
    - Scheduler logs `'Starting community PR processing'` and
      `'Community PR processing completed: <n> processed, <m> errors'`.
    - Per-PR errors → `logger.error('Failed to process PR #N for work W: <msg>', stack)`.
    - Lock contention → `logger.debug('Skipping community PR processing for work W because another instance is already processing it')`.
- **Cost**: each PR triggers one `aiFacade.askJson` call at
  `temperature: 0.3` against the work's configured AI provider.
  Cost tracking is the AI provider's responsibility (the plugin
  reports usage); there is no global budget enforcement at the
  community-PR layer.

## 5. Key Entities & Domain Concepts

| Entity / concept                                         | Description                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CommunityPrState` (`entities/types.ts`)                 | `{processedPrNumbers: number[]; processedPrs?: Array<{number, updatedAt, outcome}>; lastProcessedAt?: string; totalItemsAdded?: number; lastError?: string \| null;}` |
| `CommunityPrSinglePrResult`                              | `{outcome: 'applied' \| 'ignored'; itemsAdded: number}` — the per-PR contract.                                                                                        |
| `CommunityPrTriggerSource`                               | `'user' \| 'schedule' \| 'api'`. Differs from the original spec's three-value enum.                                                                                   |
| `CommunityPrProcessorService`                            | Drives per-work + per-PR processing. Owned by `@ever-works/agent/community-pr`.                                                                                       |
| `CommunityPrSchedulerService`                            | Hourly cron at `apps/api/src/works/tasks/community-pr-scheduler.service.ts`. Wraps `processAllWorks()` in an outer lock + try/catch.                                  |
| `extractedItemSchema`                                    | `z.object({items: z.array(z.object({name, description, source_url, category, tags: z.array(z.string())}))})`.                                                         |
| `MAX_PROCESSED_PR_NUMBERS`                               | 500 — FIFO eviction cap on both `processedPrNumbers` and `processedPrs`.                                                                                              |
| `MAX_CHANGE_CONTEXT_LENGTH`                              | 50 000 — char cap on the diff context fed to the AI prompt.                                                                                                           |
| `COMMUNITY_PR_LOCK_TTL_MS`                               | 30 minutes — per-work `community-pr:<workId>` lock TTL.                                                                                                               |
| `community-pr:<workId>` / `works:community-pr-scheduler` | Lock keys (per-work and outer scheduler).                                                                                                                             |
| `WorkHistoryActivityType.COMMUNITY_PR_MERGED`            | `work_generation_history` activity-type stamp for community-PR runs.                                                                                                  |
| `ActivityActionType.COMMUNITY_PR_MERGED`                 | `activity_logs` action-type stamp emitted ONLY by the controller path (the service does NOT emit activity-log entries directly).                                      |

## 6. Out of Scope

- **Inviting users to fix invalid PRs** — there is no
  "invalid item" comment path. The AI's response is either
  `items: []` (treated as a no-op `'ignored'`) or a populated list.
  Items that fail slug validation are silently dropped — the PR
  contributor sees only the thank-you comment for the items that
  DID land.
- **Multi-repo processing** — one main repo per work is assumed;
  `work.getMainRepo()` returns a single string.
- **Cross-work batching** — each work is processed independently
  in its own `processWork` invocation; there is no cross-work
  parallelism within `processAllWorks` (it's a serial `for` loop).
- **AI cost budgeting** — the layer relies on the AI provider
  plugin's own usage reporting; there is no global cap or kill-
  switch when monthly spend exceeds a threshold.
- **PR review comments / inline annotations** — only
  pull-request-level comments via `createPullRequestComment` are
  supported. Per-line review comments are out of scope.
- **Non-GitHub providers** — the implementation calls
  `gitFacade.*`, which routes through whichever git provider the
  work uses. GitLab / Bitbucket support is automatic IF those
  plugin implementations expose the same `listPullRequests` /
  `getPullRequestFiles` / `createPullRequestComment` /
  `closePullRequest` capabilities. Today only the `github` plugin
  implements them fully.

## 7. Acceptance Criteria

- [x] Two concurrent `processWork` calls against the same work
      yield ONE effective execution; the loser exits with `0`.
- [x] PRs already in `processedPrs` with matching `updatedAt` are
      skipped on re-runs.
- [x] PRs in `processedPrs` with newer `updatedAt` ARE re-processed.
- [x] AI returning `items: []` results in `outcome: 'ignored'`,
      no PR comment, no items added.
- [x] Items with duplicate slugs (within-run OR existing in repo)
      are silently skipped with a `logger.warn`.
- [x] State persistence captures `lastProcessedAt`, `lastError`,
      and `totalItemsAdded` after each work-level run.
- [x] `itemsCount` is incremented atomically when ≥1 items are
      added.
- [x] Controller endpoint enforces ownership + `communityPrEnabled`
      gate before invoking the service.
- [x] Controller emits the `COMMUNITY_PR_MERGED` activity-log
      entry as a fire-and-forget side effect.
- [x] Scheduler runs hourly, guarded by the outer
      `works:community-pr-scheduler` lock with 1-hour TTL.
- [x] Tests cover: lock contention; unchanged-PR skip; updated-PR
      reprocess; AI-empty-items ignore; duplicate-slug skip;
      history-write failure swallowing; comment + close failure
      swallowing.

## 8. Open Questions

- `[NEEDS CLARIFICATION: OQ-1]` Spec FR-7 vs FR-8 of the original
  spec talked about "invalid items" PR comments. The current
  implementation has NO such path — all AI failures are silent
  and surface only as `lastError` on the work's
  `communityPrState`. Should the contributor see a comment
  ("Couldn't extract items, please ensure your PR adds entries
  in <format>") on a failed extraction? That would require a
  new error class to distinguish AI failures from infrastructure
  failures.
- `[NEEDS CLARIFICATION: OQ-2]` `triggeredBy: 'user'` is reserved
  but unused. If we never wire a "run-now-on-this-PR" UI, the
  enum should drop the value to avoid drift.
- `[NEEDS CLARIFICATION: OQ-3]` `recordCommunityPrHistory`
  always sets `status: GenerateStatusType.GENERATED` — even when
  zero items were ultimately added (because the per-PR loop
  doesn't reach `recordCommunityPrHistory` in that case). Should
  there also be an `IGNORED` history entry for visibility into
  PRs the AI declined to extract from?
- `[NEEDS CLARIFICATION: OQ-4]` The `processedPrNumbers` legacy
  array is still maintained alongside `processedPrs`. Now that
  `processedPrs` carries strictly more information, the legacy
  array is dead code at read-time but still written. A future
  follow-up should drop it from the schema once we're confident
  no historical data depends on it.
- `[NEEDS CLARIFICATION: OQ-5]` Per-PR cost / token usage isn't
  surfaced anywhere visible to the work owner. A per-PR row in
  `work_generation_history` (or a richer `details` jsonb) could
  capture this so owners can see what the community PR pipeline
  is costing them.
- `[NEEDS CLARIFICATION: OQ-6]` The 30-minute per-work lock TTL
  vs the 1-hour scheduler lock TTL means that an extreme outlier
  work whose processing exceeds 30 minutes could be picked up by
  the next scheduler run while the first is still running. The
  scheduler-side outer lock prevents that across replicas, but
  the `runExclusive` for the work itself uses Postgres-backed
  TTLs that DON'T renew. Long runs should either renew the lock
  mid-loop or be explicitly time-boxed.

## 9. Constitution Gates

- [x] **I (Plugin-first)**: AI extraction and git operations both
      go through the agent-package facades (`AiFacadeService` and
      `GitFacadeService`), which dispatch to whatever AI / git
      provider plugin the work has enabled.
- [x] **II (Capability-driven)**: `aiFacade.askJson` resolves the
      AI provider via the work's configured `ai-provider`
      capability; `gitFacade.*` resolves the git provider via the
      work's `gitProvider` field.
- [x] **III (Source-of-truth repos)**: items are merged into the
      user's data repo (a separate repo from the main repo where
      the PR was opened); the platform DB stores only the
      bookkeeping state (`communityPrState`, `work_generation_history`).
- [x] **IV (Trigger.dev for long work)**: in-process coordination
      via `DistributedTaskLockService` (Postgres-backed advisory
      locks). The hourly cron is intentionally lightweight; for
      true long-running batches, future enhancements would push
      `processWork` into Trigger.dev.
- [x] **V (Forward-only migrations)**: `work.communityPrState`
      is a jsonb column added via additive migration. The
      `processedPrs` field was added later; pre-existing rows
      load with `processedPrs: undefined` and the code falls back
      to `processedPrNumbers`.
- [x] **VI (Tests)**: covered in
      `packages/agent/src/community-pr/__tests__/community-pr-processor.service.spec.ts`
      and `apps/api/src/works/tasks/community-pr-scheduler.service.spec.ts`,
      plus the controller-level surface in
      `apps/api/src/works/works.controller.comparisons-misc.spec.ts`
      (3 tests pinning the not-found / not-enabled / happy-path
      branches).
- [x] **VII (Secrets via `x-secret`)**: GitHub tokens are loaded
      via `gitFacade` from the work's plugin settings; never
      logged, never exposed in responses.
- [x] **VIII (Plugin counts in canonical doc)**: N/A — not a
      plugin.
- [x] **IX (Behaviour-first spec)**: this spec describes
      observable behaviour only.
- [x] **X (Backwards-compatible)**: state schema is additive; old
      works without `communityPrState` default to `{processedPrNumbers: [], totalItemsAdded: 0}`
      via the `||` fallback in `processWork`.

## 10. References

- User-facing doc:
  [`../../../features/community-pr-processing.md`](../../../features/community-pr-processing.md)
- Internal architecture:
  [`../../../agent-services/community-pr-service.md`](../../../agent-services/community-pr-service.md)
- Implementation:
    - [`packages/agent/src/community-pr/community-pr-processor.service.ts`](../../../../packages/agent/src/community-pr/community-pr-processor.service.ts)
    - [`packages/agent/src/community-pr/community-pr.module.ts`](../../../../packages/agent/src/community-pr/community-pr.module.ts)
    - [`apps/api/src/works/tasks/community-pr-scheduler.service.ts`](../../../../apps/api/src/works/tasks/community-pr-scheduler.service.ts)
    - [`apps/api/src/works/works.controller.ts`](../../../../apps/api/src/works/works.controller.ts) (`processCommunityPrs` endpoint)
- Lock primitive:
  [`../../../agent-services/distributed-task-lock.md`](../../../agent-services/distributed-task-lock.md)
- Related specs:
    - [`scheduled-updates`](../scheduled-updates/spec.md) — same
      lock primitive and cron pattern.
    - [`activity-log`](../activity-log/spec.md) — the audit-trail
      that the controller path emits to.
    - [`work-changelog`](../work-changelog/spec.md) — the
      `buildWorkChangelog` helper consumed by
      `recordCommunityPrHistory`.
