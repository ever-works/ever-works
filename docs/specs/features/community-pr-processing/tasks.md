# Task Breakdown: Community PR Processing

**Feature ID**: `community-pr-processing`
**Plan**: `./plan.md`
**Status**: `Done` (retrospective — surface already shipped)
**Last updated**: 2026-05-08

---

## Phase 1 — Schema (shipped)

- [x] **T1**. `communityPrState` jsonb column on `works` (additive
      migration). Type:
      `{processedPrNumbers: number[]; processedPrs?: Array<{number, updatedAt, outcome}>; lastProcessedAt?: string; totalItemsAdded?: number; lastError?: string | null}`.
      The `processedPrs` field was added later than the original
      schema; pre-existing rows load with `processedPrs: undefined`
      and the code falls back to `processedPrNumbers`.
- [x] **T2**. `communityPrEnabled` (boolean) and
      `communityPrAutoClose` (boolean) columns on `works`.

## Phase 2 — Core processor service (shipped)

- [x] **T3**. `CommunityPrProcessorService` at
      [`packages/agent/src/community-pr/community-pr-processor.service.ts`](../../../../packages/agent/src/community-pr/community-pr-processor.service.ts):
    - `processAllWorks(triggeredBy?)` — iterate all works with
      `communityPrEnabled = true`; aggregate
      `{processed, errors:[]}`.
    - `processWork(work, state?, autoClose?, triggeredBy?)` —
      per-work `runExclusive('community-pr:<workId>', fn, {ttlMs: 30*60*1000, onLocked})`.
    - `processSinglePr(...)` private method — the per-PR pipeline.
    - `recordCommunityPrHistory(...)` private method — best-effort
      `WorkGenerationHistoryRepository.createEntry` write.
    - `markPrHandled(state, pr, outcome)` private method — updates
      both `processedPrNumbers` AND `processedPrs` arrays with the
      500-entry FIFO eviction.
    - `isPrHandled(state, pr)` private method — `processedPrs`
      `updatedAt` match wins; falls back to `processedPrNumbers`
      match for pre-`processedPrs` rows.
    - `buildExtractionPrompt(...)` private method — the AI prompt
      template (workName, workDescription, categories, prTitle,
      prBody, prChanges).
- [x] **T4**. `extractedItemSchema` zod schema (5 fields per
      item: `name`, `description`, `source_url`, `category`,
      `tags`).
- [x] **T5**. `MAX_PROCESSED_PR_NUMBERS = 500`,
      `MAX_CHANGE_CONTEXT_LENGTH = 50_000`, and
      `COMMUNITY_PR_LOCK_TTL_MS = 30 * 60 * 1000` constants.

## Phase 3 — Scheduler (shipped)

- [x] **T6**. `CommunityPrSchedulerService` at
      [`apps/api/src/works/tasks/community-pr-scheduler.service.ts`](../../../../apps/api/src/works/tasks/community-pr-scheduler.service.ts):
    - `@Cron(CronExpression.EVERY_HOUR)` decorator.
    - Outer `runExclusive('works:community-pr-scheduler', fn, {ttlMs: 60*60*1000, onLocked})`.
    - Try/catch wrapping `processAllWorks()`; errors logged via
      `logger.error('Error during community PR processing', stack)`.
    - Start + completion log lines.

## Phase 4 — Controller endpoint (shipped)

- [x] **T7**. `WorksController.processCommunityPrs` at
      [`apps/api/src/works/works.controller.ts`](../../../../apps/api/src/works/works.controller.ts):
    - Path: `POST /api/works/:id/process-community-prs`.
    - Owner gate via `workQueryService.getWork(id, user)`.
    - 404 on missing work; 400 on `!work.communityPrEnabled`.
    - Delegates to `communityPrProcessorService.processWork(work)`.
    - Cache invalidation via `invalidateWorkCaches(id)`.
    - Fire-and-forget `activityLogService.log({...COMMUNITY_PR_MERGED...})`
      with `details: {itemsAdded}` and summary
      `'Processed community PRs'`.
    - Returns `{itemsAdded}` envelope.

## Phase 5 — Tests (shipped)

- [x] **T8**. Service-level unit tests in
      `packages/agent/src/community-pr/__tests__/`.
- [x] **T9**. Scheduler test at
      [`apps/api/src/works/tasks/community-pr-scheduler.service.spec.ts`](../../../../apps/api/src/works/tasks/community-pr-scheduler.service.spec.ts).
- [x] **T10**. Controller-endpoint test in
      [`apps/api/src/works/works.controller.comparisons-misc.spec.ts`](../../../../apps/api/src/works/works.controller.comparisons-misc.spec.ts)
      pinning all three branches (not-found / not-enabled /
      happy-path with `COMMUNITY_PR_MERGED` activity-log emission).

## Phase 6 — Docs (shipped)

- [x] **T11**. User-facing doc at
      `docs/features/community-pr-processing.md`.
- [x] **T12**. Architectural doc at
      `docs/agent-services/community-pr-service.md`.
- [x] **T13**. Retrospective spec / plan / tasks (this folder).

## Outstanding follow-ups

- [ ] **T14** (OQ-1) Surface AI-extraction failures back to the PR
      contributor as a comment ("Couldn't extract items, please
      ensure your PR adds entries in <format>"). Requires a new
      error class to distinguish AI-output failures from
      infrastructure failures.
- [ ] **T15** (OQ-2) Decide whether to drop `'user'` from
      `CommunityPrTriggerSource`. Currently reserved but unused.
- [ ] **T16** (OQ-3) Emit an `IGNORED`-status row in
      `work_generation_history` when AI returns `items: []` so
      owners can see what the pipeline declined to act on.
- [ ] **T17** (OQ-4) Drop the legacy `processedPrNumbers` array
      once we're confident no historical data depends on it (the
      `processedPrs` array carries strictly more information).
- [ ] **T18** (OQ-5) Track per-PR cost / token usage on the
      generation-history row's `details` jsonb.
- [ ] **T19** (OQ-6) Renew the per-work lock mid-loop on
      long-running runs OR explicitly time-box the inner loop so
      it can't exceed the 30-minute TTL.
- [ ] **T20** Add a Postgres-container integration test that
      exercises the full flow against a real `Work` row, real
      `WorkGenerationHistory` writes, and a stubbed
      `gitFacade` / `aiFacade`. Today the test surface is
      mocked-Jest only.
- [ ] **T21** Add an e2e test for the manual endpoint that
      exercises the full path (auth gate, ownership, gate, service
      call, cache invalidation, activity-log emission, response
      envelope).
- [ ] **T22** Add a `@Throttle` guard to the manual endpoint —
      `{short: {limit: 5, ttl: 60_000}}` is a reasonable starting
      point.
- [ ] **T23** Move the per-work `processWork` call into a
      Trigger.dev task per Plan §7. Long-running PRs (slow data
      repos, slow AI providers) currently block a Nest worker
      thread for the duration; Trigger.dev would isolate them.
- [ ] **T24** Surface `lastProcessedAt` / `lastError` /
      `totalItemsAdded` in the work detail page UI so the owner
      knows the pipeline is healthy without checking logs.
- [ ] **T25** Add a "review queue" UI for items the AI extracted
      but haven't been merged yet — give owners a chance to
      reject AI-extracted items before they land in the data
      repo.
- [ ] **T26** Add monitoring alarm: any `communityPrEnabled` work
      whose `lastProcessedAt < now - 6h` is suspicious (cron
      should fire hourly). Wire this into a future health-check
      surface.

## Definition of Done

- [x] All tasks in Phases 1–6 shipped.
- [x] Tests pass at every layer (service / scheduler / controller).
- [x] Docs present and accurate.
- [x] Constitution gates verified (see `spec.md` §9).
- [ ] All follow-ups in T14–T26 either shipped or explicitly
      tracked as a separate work-item per OQ-X.

## References

- [Spec](./spec.md), [Plan](./plan.md)
- Source: `packages/agent/src/community-pr/`,
  `apps/api/src/works/tasks/community-pr-scheduler.service.ts`,
  `apps/api/src/works/works.controller.ts`.
- Tests: see Phase 5.
- Related specs:
    - [`scheduled-updates`](../scheduled-updates/spec.md)
    - [`activity-log`](../activity-log/spec.md)
    - [`work-changelog`](../work-changelog/spec.md)
    - [`creating-a-work`](../creating-a-work/spec.md)
