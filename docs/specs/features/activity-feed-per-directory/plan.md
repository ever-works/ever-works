# Implementation Plan: Activity Feed per Directory

> Translates the approved [`spec.md`](./spec.md) into an architecture and tech-choice plan.
> The plan owns implementation details; the spec owns behaviour.

**Feature ID**: `activity-feed-per-directory`
**Spec**: [`./spec.md`](./spec.md)
**Tasks**: [`./tasks.md`](./tasks.md)
**Jira**: [EW-120](https://evertech.atlassian.net/browse/EW-120)
**Status**: `Draft`
**Last updated**: 2026-05-12

---

## 1. Architecture summary

```mermaid
flowchart TB
    User[Work owner opens /works/:id/activity] --> Page[apps/web RSC page.tsx]
    Page --> Client[ActivityFeedClient]
    Client -->|GET, polled every 5s| Aggregator[/api/works/:id/activity-feed]

    Aggregator --> Cache{Redis 30s cache}
    Cache -->|miss| Compose[ActivityFeedService.compose]

    Compose --> Source1[ActivityLogService.findAll workId]
    Compose --> Source2[WorkGenerationHistoryService.list workId]
    Compose --> Source3[DirectoryWebsiteClient.fetchActivityFeed]

    Source3 -->|HMAC bearer| TemplateAPI[directory-web-template<br/>GET /api/platform/activity-feed]
    TemplateAPI --> TenantDB[(deployed-site DB)]

    DeployFlow[DeployService.deploy] -->|getDeploymentSecrets| VercelPlugin[VercelPlugin]
    VercelPlugin -->|reads encrypted| Secret[(works.platform_sync_secret)]
    DeployFlow -->|setActionSecret| GHA[GitHub Actions secrets]
    GHA -->|deploy_vercel.yaml| VercelEnv[Vercel project env]
    VercelEnv --> TemplateAPI
```

**Reuses without change**:

- `ActivityLogService.findAll({ workId })` — already supports the filter (existing).
- `WorkGenerationHistoryService.list({ workId })` — existing per-Work history query.
- `ActivityDetailModal`, `HistoryExpandedDetail` — existing UI primitives, embedded in feed rows.
- `IDeploymentPlugin.getDeploymentSecrets()` — existing GHA-secret push contract; we only add a new implementation in the Vercel plugin.
- `DeployService.setSecret()` → `github-actions.service.ts:62` → `octokit.rest.actions.createOrUpdateRepoSecret()` — existing path, no changes.
- Platform config-encryption key (`@ever-works/agent/config`) used today for plugin-settings secrets — reused for `platform_sync_secret`.
- SWR + `document.hidden`-pause polling pattern from `apps/web/src/app/[locale]/activity/activity-client.tsx`.
- Existing Redis instance and `CacheModule` wiring.

**Net-new**:

- `works` columns: `platform_sync_secret_encrypted`, `platform_sync_enabled`, `platform_sync_last_success_at`, `platform_sync_last_error`.
- TypeORM migration.
- `apps/api/src/works/activity-feed/` Nest module (controller, service, DTOs).
- `packages/agent/src/services/platform-sync-secret.service.ts` — generate/encrypt/decrypt per-Work secret.
- `apps/api/src/works/activity-feed/directory-website-client.service.ts` — HMAC sign + HTTP fetch + retry + degraded mode.
- `packages/plugins/vercel/src/vercel.plugin.ts` — implement `getDeploymentSecrets()` returning `{ PLATFORM_SYNC_SECRET }`.
- Web: `apps/web/src/app/[locale]/(dashboard)/works/[id]/activity/page.tsx` server component.
- Web: `apps/web/src/components/works/detail/activity/ActivityFeedClient.tsx` and supporting files.
- Web: `apps/web/src/lib/api/works/activity-feed.ts` client.
- Web: rewired `WorkActivity.tsx` Overview widget (replace mock with real data).
- i18n: new `dashboard.workDetail.activity.*` keys across 21 locale files.
- Template-side: `apps/web/app/api/platform/activity-feed/route.ts` + workflow change in `deploy_vercel.yaml`.

## 2. Tech choices

| Concern                          | Choice                                                                                                                       | Rationale                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Polling                          | SWR `refreshInterval: 5000` with `document.hidden` pause via existing pattern (`activity-client.tsx`)                        | Matches the global `/activity` page; no new realtime infra (NFR-5, FR-8, FR-12)        |
| Auth (platform → template)       | HMAC-SHA256 over `timestamp + ':' + queryString + ':' + tenantId` with `PLATFORM_SYNC_SECRET`; 5-min drift window            | Symmetric, simple, no PKI; same shape as Stripe / GitHub webhook signing               |
| Secret encryption                | AES-GCM via platform's existing `ConfigEncryptionService` (same key used for plugin-settings secrets)                        | Reuses key management; no new key rotation surface                                     |
| Secret distribution              | `getDeploymentSecrets()` returns it as a GHA secret; `deploy_vercel.yaml` step copies it to Vercel project env via CLI       | Reuses the existing GHA-secret push path — no new Vercel env-API code on platform side |
| Aggregator cache                 | Redis, 30s TTL, key `activity-feed:{workId}:{category}:{sinceBucketMin}`                                                     | Existing Redis; staleness up to 30s is acceptable per FR-22                            |
| Deployed-site fetch              | `fetch` with `AbortController` 5s timeout, one retry on network error, no retry on 4xx                                       | Avoids amplification; degraded mode keeps the feed responsive                          |
| Concurrency on aggregator        | `requestIdRef`-style dedup client-side (matches `activity-client.tsx`)                                                       | Prevents flicker from out-of-order responses                                           |
| API auth (platform → aggregator) | Existing `WorkAccessGuard` — read permission on the Work                                                                     | Same guard used by other `/works/:id/*` endpoints                                      |
| Cache invalidation               | `@OnEvent('activity-log.created')` and `@OnEvent('work-generation.completed')` purge the per-Work cache key set              | Best-effort; staleness bounded by TTL even if a listener fails                         |
| Telemetry                        | Server action calling `@ever-works/monitoring` `AnalyticsService.track`                                                      | Same pattern as onboarding-wizard-v2; no client-side bundle additions                  |
| Tests (api)                      | Jest with mocked `HttpService` / `fetch`; integration tests against in-memory data fixtures                                  | Matches existing `apps/api` and `packages/agent` test conventions                      |
| Tests (web)                      | Vitest for hook + client component unit tests; Playwright for tab smoke test                                                 | Matches existing `apps/web/vitest.config.ts` and `apps/web/e2e/` layout                |
| Template-side route              | Next.js App Router `route.ts` handler (Node runtime), drizzle queries                                                        | Matches existing `app/api/admin/*` admin endpoints in `directory-web-template`         |

## 3. Data model

### 3.1 `works` columns (one migration)

```sql
ALTER TABLE works
  ADD COLUMN platform_sync_secret_encrypted text NULL,
  ADD COLUMN platform_sync_enabled          boolean NOT NULL DEFAULT true,
  ADD COLUMN platform_sync_last_success_at  timestamptz NULL,
  ADD COLUMN platform_sync_last_error       text NULL;
```

- `platform_sync_secret_encrypted` is base64(AES-GCM(secretBytes)). NULL means "not yet generated"; the next redeploy will populate it lazily.
- `platform_sync_enabled` defaults `true` so the feature opts in by default; the Settings toggle lets owners turn it off.
- `platform_sync_last_success_at` / `..._last_error` are best-effort observability for the degraded-mode banner.

No new indexes required — `works` is already keyed by `id` (PK) and `user_id`; per-Work lookups already hit the PK.

### 3.2 Cache key shape

```
activity-feed:{workId}:{category|all}:{sinceBucketMinute}
```

`sinceBucketMinute` is `floor(Date.now() / 60_000)`. Two consecutive polls within the same minute hit the same key; aggregator regenerates each minute even with no cache pressure.

## 4. New env vars

**Platform side**: none. The platform reuses the existing encryption key.

**Template side** (`directory-web-template`): one new var, set per-deploy by the platform's GHA-secret push:

```env
PLATFORM_SYNC_SECRET=  # 32-byte hex; populated by platform on first deploy
```

Document in template's `.env.example`. The template's new endpoint MUST return `503 sync_not_provisioned` if the env is missing, so a partial deploy fails closed rather than open.

## 5. Server-side modules

### 5.1 `apps/api/src/works/activity-feed/`

- `activity-feed.module.ts` — registers controller + service + `DirectoryWebsiteClient` + `PlatformSyncSecretService`.
- `activity-feed.controller.ts` — `@Get('/works/:id/activity-feed')`. Uses `WorkAccessGuard` + `@CurrentUser()`. Query DTO with `since`, `limit` (≤ 200), `category`.
- `activity-feed.service.ts` — `compose(workId, { since, limit, category })`:
  1. Read from Redis cache; return on hit.
  2. In parallel: `activityLogService.findAll({ workId, ... })`, `workGenerationHistoryService.list({ workId, ... })`, `directoryWebsiteClient.fetchActivityFeed(work, ...)` (only if `work.platformSyncEnabled`).
  3. Normalize each source to a common `FeedEntry` shape (see DTO).
  4. Merge timestamp DESC, truncate to `limit`, build `nextCursor` from last entry's timestamp.
  5. Attach `degraded` block if any source failed; persist `work.platformSyncLastError` / `platformSyncLastSuccessAt`.
  6. Write back to cache (30s TTL).
- `directory-website-client.service.ts` — `fetchActivityFeed(work, params)`:
  - Decrypt `work.platformSyncSecretEncrypted` via `PlatformSyncSecretService`.
  - Build query string deterministically, compute HMAC-SHA256 over `timestamp + ':' + qs + ':' + work.tenantId` (if the template is multi-tenant — fall back to `''` otherwise).
  - Fetch `${work.website}/api/platform/activity-feed?...` with `Authorization: Bearer ${hmac}`, `x-platform-ts: <iso>`, `AbortController` 5s timeout.
  - On 401 / 403 / network error / DNS / timeout / 5xx — return `{ entries: [], degraded: { reason } }`. On 200 — return parsed body.
- `dto/feed-entry.dto.ts` — `FeedEntry` shape (see §6.1 of spec.md, plus platform-side fields like `actorKind`).
- `dto/feed-response.dto.ts` — `{ entries, nextCursor?, serverTime, degraded? }`.
- `dto/feed-query.dto.ts` — class-validator schema for the query.

### 5.2 `packages/agent/src/services/platform-sync-secret.service.ts`

- `generateForWork(workId)` — 32 random bytes, hex-encode, AES-GCM-encrypt via existing `ConfigEncryptionService`, persist via `WorkRepository.update`.
- `decryptForWork(work)` — decrypt and return plaintext hex. Caches plaintext in memory per-process for the request lifetime to avoid re-decrypting.
- `getOrGenerate(workId)` — lazy: returns existing secret if `platform_sync_secret_encrypted IS NOT NULL`; otherwise generates + persists + returns.
- Module-private — only `DeployService` (via Vercel plugin) and `DirectoryWebsiteClient` should call it.

### 5.3 TypeORM migration

`apps/api/src/migrations/{nextTs}-AddWorkPlatformSync.ts` — additive, four columns. Down-migration drops them. No data backfill required (NULL is valid initial state).

### 5.4 Event listeners (cache invalidation)

In `activity-feed.service.ts`:

```ts
@OnEvent('activity-log.created')
@OnEvent('work-generation.completed')
@OnEvent('work-generation.failed')
async onWorkEvent(payload: { workId: string }) {
  await this.cache.delByPrefix(`activity-feed:${payload.workId}:`);
}
```

Best-effort — log on failure, never throw.

## 6. Plugin work

### 6.1 Modify `packages/plugins/vercel/src/vercel.plugin.ts`

Add `getDeploymentSecrets()`:

```ts
async getDeploymentSecrets(_settings: Record<string, unknown>, ctx: DeploymentContext): Promise<Record<string, string>> {
  const secret = await this.platformSyncSecretService.getOrGenerate(ctx.workId);
  return { PLATFORM_SYNC_SECRET: secret };
}
```

The `ctx: DeploymentContext` parameter is passed by `DeployService` and includes `workId`. If `DeploymentContext` doesn't already carry `workId`, this small extension lands in the same commit (the K8s plugin's existing `getDeploymentSecrets()` already needs work context — check before assuming a new param).

Unit test: returns expected shape with a deterministic mock secret service.

### 6.2 No other plugin changes

K8s plugin already has `getDeploymentSecrets()`. We do not modify it for v1 since the spec scopes deployed-site sync to Vercel-deployed Works. K8s-deployed Works render the feed without the deployed-site source until a follow-up adds K8s-side `PLATFORM_SYNC_SECRET` injection.

## 7. Web changes

### 7.1 New components (`apps/web/src/components/works/detail/activity/`)

- `ActivityFeedClient.tsx` — top-level client component:
  - `useSWR('/api/works/:id/activity-feed?...', { refreshInterval: 5000, refreshWhenHidden: false, dedupingInterval: 2000 })`.
  - `document.hidden` pause via `visibilitychange` listener; resume with one immediate revalidate on focus.
  - `requestIdRef` to discard out-of-order responses (mirror `activity-client.tsx:55-237`).
  - Renders `FeedFilterChips` + `FeedList` + optional `DegradedBanner`.
- `FeedFilterChips.tsx` — chip group with active state. Active filter syncs to `?category=...` URL.
- `FeedList.tsx` — list virtualization NOT required (limit 25 default). Each row is a `FeedRow`.
- `FeedRow.tsx` — switches by `entry.source` (`'platform-activity-log'` | `'generation-history'` | `'directory-site'`) and renders:
  - **platform-activity-log** → click opens existing `ActivityDetailModal`.
  - **generation-history** → click navigates to `/works/:id/generator/history?run=<id>`.
  - **directory-site** → click opens `entry.target.adminUrl` in new tab.
- `DegradedBanner.tsx` — yellow info banner: "Deployed-site events unavailable — last success at <relativeTime>".
- `EmptyState.tsx` — shown when zero entries across all sources.
- `SkeletonList.tsx` — 8 placeholder rows.

### 7.2 Tab + route + constants

- `WorkTabs.tsx` — insert new tab between Overview (index 0) and Items (now index 2):
  ```tsx
  {
    name: t('activity'),
    href: ROUTES.DASHBOARD_WORK_ACTIVITY(work.id),
    icon: /* pulse / activity icon SVG */,
    isActive: pathname.includes('/activity')
  }
  ```
- `constants.ts` — add `DASHBOARD_WORK_ACTIVITY: (id) => /works/${id}/activity`.
- `apps/web/src/app/[locale]/(dashboard)/works/[id]/activity/page.tsx` — server component, calls `workAPI.get(id)` server-side to confirm access, renders `<ActivityFeedClient workId={id} initialCategory={searchParams.category} />`.

### 7.3 API client

- `apps/web/src/lib/api/works/activity-feed.ts` — `getActivityFeed(workId, params): Promise<FeedResponse>` calling `GET /api/works/:id/activity-feed`.

### 7.4 Overview widget rewire

- `apps/web/src/components/works/detail/overview/WorkActivity.tsx` — drop hardcoded mock; call `getActivityFeed(workId, { limit: 5 })`. SWR with the same `refreshInterval: 5000` and pause-when-hidden.
- "View all →" link to `ROUTES.DASHBOARD_WORK_ACTIVITY(work.id)`.
- Empty state when zero entries.

### 7.5 i18n

New namespace under `dashboard.workDetail.activity` in every locale (en + 20):

```json
{
  "tabs": { "activity": "Activity Feed" },
  "activity": {
    "title": "Activity Feed",
    "subtitle": "Everything that's happening on this directory",
    "empty": { "title": "No activity yet", "body": "Run a generation to see events here." },
    "filters": {
      "all": "All",
      "generation": "Generation",
      "items": "Items",
      "deployment": "Deployment",
      "settings": "Settings",
      "comparisons": "Comparisons",
      "communityPr": "Community PR",
      "users": "Users",
      "submissions": "Submissions",
      "reports": "Reports"
    },
    "actions": { "refresh": "Refresh", "viewAll": "View all" },
    "degraded": { "title": "Deployed-site events unavailable", "lastSuccess": "Last success: {time}" },
    "entry": {
      "userRegistered": "{name} registered",
      "itemCreated": "{name} submitted {item}",
      "itemStatusChanged": "{item} → {status}",
      "reportCreated": "{name} reported {target}",
      "generationCompleted": "Generation completed ({items} items)",
      "generationFailed": "Generation failed",
      "deployed": "Deployed to {target}",
      "pluginEnabled": "{plugin} enabled"
    }
  }
}
```

The 20 non-English locales receive the English strings as placeholders in this PR; translation handed to the i18n process per existing convention (matches what `onboarding-wizard-v2` did).

## 8. Template-side changes (`directory-web-template`)

Coordinated minimal PR.

### 8.1 New route

`apps/web/app/api/platform/activity-feed/route.ts`:

- Read `PLATFORM_SYNC_SECRET` from env; 503 if missing.
- Parse query (`since`, `limit ≤ 200`, `types`).
- Verify HMAC: read `Authorization: Bearer <hmac>` and `x-platform-ts`; compute expected HMAC; constant-time compare; reject on drift > 5min.
- Resolve tenant from request (existing tenant resolver — or default tenant if single-tenant).
- Union three queries (drizzle):
  - `clientProfiles` ordered by `createdAt DESC` (sign-ups).
  - `itemAuditLogs` where `action IN ('CREATED','STATUS_CHANGED')` ordered by `createdAt DESC`.
  - `reports` ordered by `createdAt DESC`.
- Each capped at `ceil(limit / activeTypeCount)`; union sorted DESC; truncated to `limit`.
- Map each to the normalized `FeedEntry` shape from §5.1 with `adminUrl` set to the deployed site's local admin URL (e.g., `/admin/users/<id>`).
- Return `{ entries, nextCursor, serverTime }`.

### 8.2 Workflow change

`directory-web-template/.github/workflows/deploy_vercel.yaml` (or whichever the template uses for prod deploy):

Add a step before the `vercel deploy` step:

```yaml
- name: Sync PLATFORM_SYNC_SECRET to Vercel env (production)
  if: ${{ secrets.PLATFORM_SYNC_SECRET != '' }}
  run: |
    echo "${{ secrets.PLATFORM_SYNC_SECRET }}" \
      | vercel env add PLATFORM_SYNC_SECRET production \
        --token=${{ secrets.VERCEL_TOKEN }} \
        --yes \
      || echo "env already set"
```

The `|| echo "env already set"` swallows the "duplicate env" error on second run (Vercel CLI errors on duplicate adds; an idempotent path is a follow-up if the noise is annoying).

### 8.3 Tests

- Vitest unit test for HMAC verification (good signature, bad signature, expired timestamp).
- Vitest unit test for the union+merge+limit logic with seeded drizzle fixtures.
- Vitest unit test for missing env → 503.

## 9. Telemetry events

All emitted through the existing server action pattern (no new client bundle). Events carry `userId`, `workId`, `feedVersion: 'v1'`.

| Event                          | Required props                                       | When                                          |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------- |
| `activity_feed_tab_viewed`     | none                                                 | First render of the new tab                   |
| `activity_feed_filter_changed` | `category`                                           | User clicks a filter chip                     |
| `activity_feed_refresh_clicked` | none                                                | Manual refresh button                         |
| `activity_feed_entry_clicked`  | `entry.source`, `entry.type`                         | User clicks a row                             |
| `activity_feed_degraded_shown` | `reason: 'timeout'\|'401'\|'5xx'\|'network'\|'disabled'` | Degraded banner becomes visible           |
| `activity_feed_overview_widget_view_all_clicked` | none                               | "View all →" link in Overview widget         |

## 10. Failure modes

| Scenario                                                  | Behaviour                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed-site endpoint times out                          | Aggregator returns platform sources + `degraded: { directorySite: { reason: 'timeout' } }`. Banner shown. `work.platformSyncLastError` set. |
| Deployed-site returns 401                                 | Same as above, `reason: 'unauthorized'`. Most likely cause: secret drift between platform DB and the deployed Vercel env. Logged with `workId`. |
| Deployed-site returns 5xx                                 | Same as above, `reason: 'upstream_5xx'`. No retry beyond the single network-error retry.                                               |
| `work.platform_sync_secret_encrypted` is NULL             | `DirectoryWebsiteClient` returns degraded `reason: 'not_provisioned'`. Banner notes "Will sync from next deploy." No exception thrown. |
| `work.platform_sync_enabled` is false                     | Aggregator skips the deployed-site source entirely. No banner.                                                                          |
| Redis is down                                             | Cache layer logs and falls through to live composition. Performance degrades; functionality intact.                                     |
| Aggregator throws                                         | Existing NestJS exception filter returns 500. Client renders empty state with a transient retry button (not a degraded banner — this is a platform bug).  |
| Template's tenant resolver fails                          | Template returns 500; aggregator handles as "5xx degraded".                                                                            |
| Encryption key rotation                                   | New secrets encrypt with new key; existing secrets still decrypt with the rotation-aware key path provided by `ConfigEncryptionService`. |
| Concurrent first-deploy generates two secrets             | `getOrGenerate(workId)` uses `UPDATE ... WHERE platform_sync_secret_encrypted IS NULL RETURNING ...` to ensure idempotency. One wins, the other reads. |

## 11. Rollout

Per the saved `feedback_no_prelaunch_compat` memory: no v2 feature flag, no ramp ceremony.

- **Migration**: lands on `develop` in the same PR as code. Forward-only, additive.
- **Default**: `platform_sync_enabled = true` for new and existing Works. Sync starts working per-Work on each Work's next redeploy (when the secret gets generated and pushed to GHA).
- **Pre-redeploy state**: feeds show platform-side events normally; deployed-site source renders the "not_provisioned" degraded banner. This is acceptable — no user-visible breakage.
- **Release flow**: `develop → stage → main`, per release-flow memory. Template PR coordinates: stage and main of platform reach parity with stage/main of `directory-web-template` before the secret-push step exists, so platform's degraded banner is the worst case during the window.

## 12. PR breakdown

**Platform repo PR** (`feat/ew-120-activity-feed` → `develop`), commits in order:

1. **docs(ew-120)**: spec + plan + tasks (already landed in this branch).
2. **feat(api)**: works columns + migration + `PlatformSyncSecretService`.
3. **feat(api)**: activity-feed aggregator module (controller + service + `DirectoryWebsiteClient` + DTOs) + cache invalidation listeners.
4. **feat(plugins/vercel)**: implement `getDeploymentSecrets()` returning `PLATFORM_SYNC_SECRET`.
5. **feat(web)**: tab insert, route page, `ActivityFeedClient` + filter chips + filter URL sync + skeleton + empty state + degraded banner.
6. **refactor(web)**: rewire Overview's `WorkActivity` widget to use the real aggregator.
7. **feat(i18n)**: new `dashboard.workDetail.activity.*` keys across 21 locales (English real, others placeholder).
8. **test**: Vitest/Jest unit + integration tests, Playwright tab smoke test.

**Template repo PR** (`feat/ew-120-activity-feed-endpoint` → `develop` of `directory-web-template`), commits in order:

1. **feat(api)**: `/api/platform/activity-feed` route + HMAC auth + union query + Vitest tests.
2. **chore(workflows)**: `deploy_vercel.yaml` push `PLATFORM_SYNC_SECRET` to Vercel env.
3. **docs**: `.env.example` documents `PLATFORM_SYNC_SECRET`.

Coordinated merge order: template PR first, then platform PR. Until the template PR lands, the platform's degraded banner is the visible state for Vercel-deployed Works. After both merge, on each Work's next redeploy, sync goes live.
