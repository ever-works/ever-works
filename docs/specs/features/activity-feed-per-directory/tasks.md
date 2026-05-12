# Task Breakdown: Activity Feed per Directory

> Ordered, granular tasks derived from [`plan.md`](./plan.md). Each task is small enough
> to land in a single commit (and ideally tested) per Constitution Principle VI.

**Feature ID**: `activity-feed-per-directory`
**Plan**: [`./plan.md`](./plan.md)
**Jira**: [EW-120](https://evertech.atlassian.net/browse/EW-120)
**Status**: `Draft`
**Last updated**: 2026-05-12

---

## How to use

- Phases are sequential. Within a phase, tasks marked `(parallel)` can run alongside their predecessor.
- Each task names explicit file paths so an implementer can pick it up cold.
- Use the checkbox to track progress as commits land on `feat/ew-120-activity-feed`.
- Add new tasks at the bottom rather than renumbering.

## Phase 1 — Data model + secret service (commit: `feat(api): work platform_sync columns`)

- [ ] **T1**. Add the four new columns to `packages/agent/src/entities/work.entity.ts`:
    - `platformSyncSecretEncrypted` (`text`, nullable).
    - `platformSyncEnabled` (`boolean`, default `true`, not null).
    - `platformSyncLastSuccessAt` (`timestamptz`, nullable).
    - `platformSyncLastError` (`text`, nullable).
      Update relevant entity tests under `packages/agent/src/entities/__tests__/`.
- [ ] **T2**. Hand-written TypeORM migration at `apps/api/src/migrations/{nextTs}-AddWorkPlatformSync.ts`. Up adds four columns. Down drops them. No data backfill.
- [ ] **T3**. New service `packages/agent/src/services/platform-sync-secret.service.ts` with:
    - `generateForWork(workId)` — 32 random bytes → hex → AES-GCM encrypt via existing `ConfigEncryptionService` → persist via `WorkRepository.update`.
    - `decryptForWork(work)` — returns plaintext hex; per-request memoisation.
    - `getOrGenerate(workId)` — uses `UPDATE works SET platform_sync_secret_encrypted=$1 WHERE id=$2 AND platform_sync_secret_encrypted IS NULL RETURNING platform_sync_secret_encrypted` to be idempotent under concurrent first-deploys.
- [ ] **T4**. Jest specs for `platform-sync-secret.service.spec.ts`: encrypt round-trip, idempotent get-or-generate under concurrent calls (simulate two `getOrGenerate` for same `workId`), missing key → throws.
- [ ] **T5**. Wire the service into the relevant agent module (likely `packages/agent/src/services/work.module.ts`) and export from `packages/agent/src/services/index.ts`.
- [ ] **T6**. `pnpm test --filter @ever-works/agent` clean. Commit: `feat(api): work platform_sync columns + secret service`.

## Phase 2 — Aggregator API (commit: `feat(api): activity-feed aggregator`)

- [ ] **T7**. New module dir `apps/api/src/works/activity-feed/`. Add `activity-feed.module.ts` registering controller, service, `DirectoryWebsiteClient`, with imports for `ActivityLogModule`, `WorkGenerationHistoryModule`, `HttpModule`, `CacheModule`, `PlatformSyncSecretModule`.
- [ ] **T8**. DTOs:
    - `dto/feed-entry.dto.ts` — `FeedEntry` discriminated by `source: 'platform-activity-log' | 'generation-history' | 'directory-site'`, plus `type`, `timestamp`, `summary`, `actor?`, `target?`, `metadata?`.
    - `dto/feed-response.dto.ts` — `{ entries: FeedEntry[]; nextCursor?: string; serverTime: string; degraded?: { directorySite?: { reason: string } } }`.
    - `dto/feed-query.dto.ts` — class-validator-decorated: `since?` (ISO, optional), `limit?` (1–200, default 50), `category?` (enum), `cursor?`.
- [ ] **T9**. `activity-feed.controller.ts` exposing `GET /api/works/:id/activity-feed`:
    - Decorated with `@UseGuards(JwtAuthGuard, WorkAccessGuard)`.
    - Validates query via `FeedQueryDto`.
    - Returns `FeedResponseDto`.
- [ ] **T10**. `activity-feed.service.ts` `compose(workId, query)`:
    - Read Redis cache first (`CacheManager.get(cacheKey)`).
    - On miss, in parallel:
        - `activityLogService.findAll({ workId, since, limit })` → map to platform-activity-log entries.
        - `workGenerationHistoryService.list({ workId, since, limit })` → map to generation-history entries.
        - If `work.platformSyncEnabled && work.website`: `directoryWebsiteClient.fetchActivityFeed(work, { since, limit, types: deriveTypesFrom(category) })`.
    - Filter by `category` if provided.
    - Merge by timestamp DESC, truncate to `limit`, derive `nextCursor` from the oldest entry's timestamp.
    - Persist `platformSyncLastSuccessAt` on success or `platformSyncLastError` on failure (best-effort; do NOT await on the hot path).
    - Write to cache (TTL 30s).
- [ ] **T11**. `directory-website-client.service.ts`:
    - `fetchActivityFeed(work, params): Promise<{ entries: FeedEntry[]; degraded?: ... }>`.
    - Resolve secret via `platformSyncSecretService.decryptForWork(work)`; if null → `{ entries: [], degraded: { reason: 'not_provisioned' } }`.
    - Build deterministic query string (sorted keys), compute HMAC-SHA256 over `timestamp + ':' + qs + ':' + (work.tenantId ?? '')` using Node's `crypto`.
    - `fetch` with `AbortController` (5s timeout), `Authorization: Bearer ${hmac}`, `x-platform-ts: <iso>`, `User-Agent: ever-works-platform/activity-feed`.
    - One retry on network error / 5xx with 200ms backoff. No retry on 4xx.
    - Map upstream response entries (cast through Zod schema) to `FeedEntry` shape with `source: 'directory-site'`.
- [ ] **T12**. Cache invalidation: `@OnEvent('activity-log.created')`, `@OnEvent('work-generation.completed')`, `@OnEvent('work-generation.failed')` handlers in `activity-feed.service.ts` that `cache.delByPrefix('activity-feed:${payload.workId}:')`. Log + swallow errors.
- [ ] **T13**. Wire `ActivityFeedModule` into `apps/api/src/works/works.module.ts` (or the top-level module that mounts work-scoped routes).
- [ ] **T14**. Jest specs at `apps/api/src/works/activity-feed/__tests__/`:
    - `activity-feed.service.spec.ts` — merge ordering, limit truncation, category filtering, degraded propagation, cache hit short-circuits the live calls, cache invalidation handler called on event.
    - `directory-website-client.service.spec.ts` — happy path, timeout → degraded, 401 → degraded, 5xx → degraded with retry attempted once, network error → degraded with retry, HMAC signature deterministic given same inputs.
    - `activity-feed.controller.spec.ts` — auth required, work-access guard enforced, query validation rejects `limit > 200`.
- [ ] **T15**. `pnpm test --filter ever-works-api` and `packages/agent` clean. Commit: `feat(api): activity-feed aggregator with cache + degraded-mode directory-site source`.

## Phase 3 — Vercel plugin secret push (commit: `feat(plugins/vercel): platform sync secret`)

- [ ] **T16**. Confirm the `DeploymentContext` shape passed by `DeployService.deploy` to `plugin.getDeploymentSecrets()`. If it doesn't include `workId`, extend it in the plugin contract (`packages/plugin/src/contracts/capabilities/deployment.interface.ts`) and the consumer (`apps/api/src/plugins-capabilities/deploy/deploy.service.ts`). Keep the change minimal — `workId: string` only.
- [ ] **T17**. Inject `PlatformSyncSecretService` into the Vercel plugin via the plugin's DI surface (or via a service locator if plugins receive Nest providers — check existing `k8s.plugin.ts` pattern).
- [ ] **T18**. Implement `getDeploymentSecrets()` in `packages/plugins/vercel/src/vercel.plugin.ts`:
    ```ts
    async getDeploymentSecrets(_settings, ctx) {
      const secret = await this.platformSyncSecretService.getOrGenerate(ctx.workId);
      return { PLATFORM_SYNC_SECRET: secret };
    }
    ```
- [ ] **T19**. Update `packages/plugins/vercel/src/__tests__/vercel.plugin.spec.ts` to assert `getDeploymentSecrets` returns `PLATFORM_SYNC_SECRET` and calls `getOrGenerate(ctx.workId)`. Mock `PlatformSyncSecretService`.
- [ ] **T20**. `pnpm test --filter @ever-works/vercel-plugin` clean. Commit: `feat(plugins/vercel): inject PLATFORM_SYNC_SECRET via getDeploymentSecrets`.

## Phase 4 — Web tab + route + client component (commit: `feat(web): activity feed tab`)

### Tab + constants

- [ ] **T21**. `apps/web/src/lib/constants.ts` — add `DASHBOARD_WORK_ACTIVITY: (id: string) => /works/${id}/activity` (place between `DASHBOARD_WORK` and `DASHBOARD_WORK_ITEMS` alphabetically/logically).
- [ ] **T22**. `apps/web/src/components/works/detail/WorkTabs.tsx` — insert new tab object at index 1 (between Overview and Items). i18n key `tabs.activity`. Choose a pulse / activity SVG icon consistent with the existing tab icon vocabulary.

### API client + page

- [ ] **T23**. `apps/web/src/lib/api/works/activity-feed.ts` — `getActivityFeed(workId, { since?, limit?, category?, cursor? }): Promise<FeedResponse>` calling `GET /api/works/:id/activity-feed` via the existing `apiFetch` wrapper.
- [ ] **T24**. Server component `apps/web/src/app/[locale]/(dashboard)/works/[id]/activity/page.tsx`:
    - Reads `params.id` and `searchParams.category` (Next.js 16 async-API pattern).
    - Fetches work via `workAPI.get(id)` server-side for access check (existing pattern).
    - Renders `<ActivityFeedClient workId={id} initialCategory={category} />` inside the existing work-detail layout.

### Client components

- [ ] **T25**. `apps/web/src/components/works/detail/activity/ActivityFeedClient.tsx`:
    - `useSWR(['activity-feed', workId, category], () => getActivityFeed(workId, { category, limit: 25 }), { refreshInterval: 5000, refreshWhenHidden: false, dedupingInterval: 2000 })`.
    - `visibilitychange` listener: pause polling while hidden (`mutate(undefined, { revalidate: false })` + cancel), resume with one `mutate()` on visible (mirror `apps/web/src/app/[locale]/activity/activity-client.tsx:192-237`).
    - `requestIdRef` to discard out-of-order responses.
    - Renders skeleton during initial load, empty state when zero entries, list otherwise.
- [ ] **T26**. `apps/web/src/components/works/detail/activity/FeedFilterChips.tsx`:
    - Props: `value: Category`, `onChange: (c: Category) => void`, `degraded?: boolean` (dims deployed-site chips when degraded).
    - Chips: All, Generation, Items, Deployment, Settings, Comparisons, Community PR, Users, Submissions, Reports.
    - Sync to URL via `router.replace` (shallow) on change.
- [ ] **T27**. `apps/web/src/components/works/detail/activity/FeedRow.tsx`:
    - Switches by `entry.source`:
        - `platform-activity-log` → click opens `ActivityDetailModal` (existing).
        - `generation-history` → `<Link href={DASHBOARD_WORK_HISTORY(workId)}?run=<id>>`.
        - `directory-site` → `<a href={entry.target.adminUrl} target="_blank" rel="noopener">`.
- [ ] **T28**. `apps/web/src/components/works/detail/activity/DegradedBanner.tsx` — yellow banner reading title + "Last success: <relativeTime>" / "Not yet provisioned". Dismissible-per-session (sessionStorage).
- [ ] **T29**. `apps/web/src/components/works/detail/activity/EmptyState.tsx` and `SkeletonList.tsx` — stateless presentational.

### Telemetry

- [ ] **T30**. New server action `apps/web/src/app/actions/dashboard/activity-feed-track.ts` — `'use server'` calling `AnalyticsService.track` with a whitelist of event names from `plan.md` §9.
- [ ] **T31**. Wire events: tab view (in `ActivityFeedClient` mount), filter change, refresh click, entry click, degraded banner shown.

### i18n

- [ ] **T32**. Add the new namespace `dashboard.workDetail.activity` and `dashboard.workDetail.tabs.activity` to `apps/web/messages/en.json` per `plan.md` §7.5.
- [ ] **T33**. Copy English placeholders into the other 20 locale files (`ar`, `bg`, `de`, `es`, `fr`, `he`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `ru`, `th`, `tr`, `uk`, `vi`, `zh`). Translation arrives via the i18n process; this commit just unblocks the build.

### Tests

- [ ] **T34**. Vitest unit tests at `apps/web/src/components/works/detail/activity/__tests__/`:
    - `ActivityFeedClient.unit.spec.tsx` — initial fetch happens, document.hidden pauses polling, resume fetches once, filter change updates URL.
    - `FeedFilterChips.unit.spec.tsx` — click changes URL, deployed-site chips dim when `degraded`.
    - `FeedRow.unit.spec.tsx` — click handler matches source.
- [ ] **T35**. Playwright e2e at `apps/web/e2e/activity-feed.spec.ts`:
    - Open Activity Feed tab on a Work with seeded `activity_log` rows; assert entries render.
    - Click a generation entry → assert URL navigates to `/works/:id/generator/history?run=...`.
    - Toggle a filter chip → URL gains `?category=`.

### Commit

- [ ] **T36**. `pnpm lint && pnpm type-check && pnpm test --filter @ever-works/web` clean. Web build (`pnpm build --filter @ever-works/web`) clean. Commit: `feat(web): activity feed tab with merged sources, polling, and filter chips`.

## Phase 5 — Overview widget rewire (commit: `refactor(web): overview activity widget uses real data`)

- [ ] **T37**. `apps/web/src/components/works/detail/overview/WorkActivity.tsx` — drop hardcoded mock. Use SWR (`refreshInterval: 5000`, paused-when-hidden) over `getActivityFeed(workId, { limit: 5 })`.
- [ ] **T38**. Add "View all →" link to `ROUTES.DASHBOARD_WORK_ACTIVITY(workId)`.
- [ ] **T39**. Empty state when zero entries; skeleton during initial load.
- [ ] **T40**. Vitest unit test for the rewired widget at `apps/web/src/components/works/detail/overview/__tests__/WorkActivity.unit.spec.tsx`.
- [ ] **T41**. `pnpm lint && pnpm type-check` clean. Commit: `refactor(web): overview activity widget uses real data`.

## Phase 6 — Template repo: deployed-site endpoint (separate PR in `directory-web-template`)

- [ ] **T42**. From a worktree of `directory-web-template`, branch `feat/ew-120-activity-feed-endpoint` off its `develop`.
- [ ] **T43**. New route `apps/web/app/api/platform/activity-feed/route.ts`:
    - Node runtime.
    - 503 if `process.env.PLATFORM_SYNC_SECRET` is missing.
    - Read `Authorization: Bearer <hmac>`, `x-platform-ts: <iso>`.
    - Constant-time HMAC compare; reject on bad signature or drift > 5min.
    - Resolve tenant (existing tenant resolver — or the template's default tenant if single-tenant).
    - Parse query (`since`, `limit ≤ 200`, `types`).
    - Drizzle union over `clientProfiles`, `itemAuditLogs` (action IN CREATED, STATUS_CHANGED), `reports`. Each capped to `ceil(limit / activeTypeCount)`.
    - Merge timestamp DESC; truncate to `limit`; build `nextCursor`.
    - Map each row to `FeedEntry` with `adminUrl` set to `/admin/<entity-type>/<id>` (or whatever the template's admin route convention is).
- [ ] **T44**. Vitest tests for the new route:
    - HMAC verification: good / bad / expired.
    - Missing env → 503.
    - Union ordering + limit + type filter.
    - Tenant scoping returns only matching tenant's rows.
- [ ] **T45**. Update `apps/web/.env.example` to document `PLATFORM_SYNC_SECRET`.
- [ ] **T46**. Update `.github/workflows/deploy_vercel.yaml` (or the equivalent prod-deploy workflow) to push `PLATFORM_SYNC_SECRET` into the Vercel project env via `vercel env add` before the deploy step, gated by `if: ${{ secrets.PLATFORM_SYNC_SECRET != '' }}`. Idempotent — swallows "already exists" with `|| true`.
- [ ] **T47**. `pnpm lint && pnpm type-check && pnpm test --filter @ever-works/directory-web` clean. Commit: `feat(api): platform activity-feed endpoint with HMAC auth`.
- [ ] **T48**. Open PR `feat/ew-120-activity-feed-endpoint` → `develop` of `directory-web-template`. PR body links to this plan + the platform PR.

## Phase 7 — Final integration + release

- [ ] **T49**. Squash-or-keep-as-is review on the platform branch: re-read commit titles, drop any incidental noise.
- [ ] **T50**. Open platform PR `feat/ew-120-activity-feed` → `develop`. PR body:
    - Link to `spec.md`, `plan.md`, `tasks.md`.
    - Link to Jira EW-120.
    - Link to the coordinated `directory-web-template` PR (note: that PR should be merged first for full functionality, but platform PR is safe to merge independently — it just shows the degraded banner until template lands).
    - Screenshots of the tab + Overview widget.
- [ ] **T51**. PR review loop per memory `feedback_pr_review_loop` — poll Codex / CodeRabbit / Copilot reviews, fix P2+ on the same branch, re-poll until clean.
- [ ] **T52**. Develop → stage → main on the template repo first.
- [ ] **T53**. Develop → stage → main on the platform repo.
- [ ] **T54**. Per memory `feedback_delete_branch_after_merge`: delete `feat/ew-120-activity-feed` after merge (and the template branch).
- [ ] **T55**. Update Jira EW-120: link both PRs, transition to In Progress on first commit, Done on main merge.

## Phase 8 — Post-merge follow-ups

Out-of-scope-for-this-PR items captured here so they don't get lost:

- [ ] **T56**. K8s deployment path: when a Work is deployed via the K8s plugin (not Vercel), inject `PLATFORM_SYNC_SECRET` into the K8s deployment env (extend the existing k8s plugin's `getDeploymentSecrets` or its deploy template). Today the K8s path will show the "not_provisioned" degraded banner.
- [ ] **T57**. WebSocket / SSE realtime: replace the 5s poll with a push channel once the platform has one. Until then, polling is the canonical pattern.
- [ ] **T58**. Mark-as-read + per-user unread badge on the tab. Requires schema work on `users` × `activity_log` (or a side table); separate spec.
- [ ] **T59**. Secret rotation: provide a CLI / admin endpoint to force-regenerate `platform_sync_secret` for a Work and re-push on next deploy.
- [ ] **T60**. Member-related events filter chip — re-enable when the Members tab returns (it was removed from `WorkTabs.tsx` recently).
- [ ] **T61**. Translate the 20 placeholder locales for `dashboard.workDetail.activity.*` via the i18n process.
