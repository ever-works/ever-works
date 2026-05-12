# Feature Specification: Activity Feed per Directory

> Behaviour-first spec per [Constitution Principle IX](../../memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Save implementation
> details for `plan.md`. Mark any unresolved questions with `[NEEDS CLARIFICATION: …]`.

**Feature ID**: `activity-feed-per-directory`
**Branch**: `feat/ew-120-activity-feed`
**Jira**: [EW-120](https://evertech.atlassian.net/browse/EW-120)
**Status**: `Draft` — awaiting owner sign-off before implementation.
**Created**: 2026-05-12
**Last updated**: 2026-05-12
**Owner**: ever@ever.co

---

## 1. Overview

Today, a Work (directory) owner who wants to know "what's happening on this directory" has to look in three different places: the global `/activity` page (filtered manually by Work), the `/works/:id/generator/history` page (generation runs only), and the deployed site's admin area (user signups, submissions, reports). There is no single place that answers "what changed on this directory in the last hour?".

This feature adds an **Activity Feed** tab on the directory detail page, sitting between **Overview** and **Items**. The feed merges three streams into a single time-ordered timeline:

1. **Platform-internal events** for this Work (already captured): generation runs, deploys, plugin enable/configure, template fork, settings updates, schedule events, community PR merges.
2. **Generation runs** with light per-run summaries (already captured): deep-link to the existing `/generator/history` page for full details.
3. **Deployed-site events** (NEW source): user registrations, item submissions, content reports — pulled from each Work's deployed `directory-web-template` instance via a new internal endpoint authenticated by a per-Work shared secret.

The existing `/generator/history` page is **kept as-is**. It's the focused "Generation Runs" deep-dive surface; the new Activity Feed is the broader directory-wide timeline. The two are complementary, not duplicate.

The owner can refresh the feed manually or rely on automatic 5-second polling (same pattern as the existing global `/activity` page). Each entry is clickable and either expands inline or deep-links to the relevant detail surface.

## 2. User scenarios

The "user" is a logged-in Work owner or member with read access to the Work.

### 2.1 Primary scenarios

- **Happy path (active directory)**: **Given** the user opens a directory that has had recent generation runs, a deploy, and new signups on the deployed site, **when** they click the Activity Feed tab, **then** the page lists every event from all three streams sorted newest first, with the most recent ten visible above the fold.

- **Tab placement**: **Given** the user is on any directory detail page, **when** the page renders, **then** the tab strip shows in this order: **Overview · Activity Feed · Items · Generator · Plugins · Deploy · Settings**, with permission gating unchanged from today (Generator, Plugins, Deploy, Settings remain permission-gated; Activity Feed is visible to anyone who can see the Work).

- **Drill into a generation run**: **Given** a "Generation completed" entry is visible, **when** the user clicks it, **then** they are navigated to `/works/:id/generator/history?run=<id>` and the existing per-run detail view opens — no information is duplicated in the feed itself beyond a summary line.

- **Drill into a deploy event**: **Given** a "Deployed to production" entry is visible, **when** the user clicks it, **then** the existing `ActivityDetailModal` opens inline with full activity-log details (status, summary, live logs if still running).

- **Drill into a deployed-site event**: **Given** a "User Maria registered" entry is visible, **when** the user clicks it, **then** a new tab opens to the deployed site's `/admin/users/<id>` (or equivalent) URL.

- **Filter by category**: **Given** the user opens the feed, **when** they click a filter chip (e.g., "Deployment"), **then** the feed re-renders showing only entries of that category, the active chip is highlighted, and the URL gains `?category=deployment` so the filter survives navigation.

- **Manual refresh**: **Given** the user is on the feed, **when** they click the Refresh control, **then** the feed re-fetches from all sources, shows a brief spinner without unmounting visible rows, and replaces the list when data returns.

- **Auto-poll while a generation is running**: **Given** the user opens the feed while a generation is in `in_progress` state, **when** five seconds pass, **then** the feed re-fetches silently and the running entry updates in place (status, summary, elapsed time) without scroll jump.

- **Tab-hidden pause**: **Given** auto-poll is active, **when** the browser tab loses focus, **then** polling pauses until the tab regains focus, at which point it resumes immediately with one refresh.

### 2.2 Cross-cutting UX scenarios

- **Empty state**: **Given** a freshly-created Work with no events on either stream yet, **when** the user opens the feed, **then** the page shows an empty-state illustration with a one-liner pointing to the Generator tab to start the first run.

- **Loading state**: **Given** the feed page mounts, **when** the first fetch is in flight, **then** the page shows a skeleton list (8 rows) so the layout doesn't jump when data arrives.

- **Partial degradation**: **Given** the deployed-site source is unreachable (site is down, DNS broken, sync disabled), **when** the feed renders, **then** platform-internal and generation-run events are shown normally and a non-blocking banner notes "Deployed-site events unavailable — last success: <timestamp>". Other categories continue to work.

- **Recent activity widget on Overview**: **Given** the user opens the Overview tab, **when** the page renders, **then** the placeholder `WorkActivity` widget is replaced by the five most-recent feed entries (real data, not mock) with a "View all →" link to the new Activity Feed tab.

- **Mobile / narrow viewport**: **Given** a viewport < 640px, **when** the user opens the feed, **then** filter chips wrap, each row stacks vertically (icon + relative time + summary + category badge), and tap targets remain ≥ 44px tall.

### 2.3 Provisioning and deployed-site sync scenarios

- **First-deploy secret bootstrap**: **Given** a Work is being deployed for the first time after this feature lands, **when** the deploy plugin's `getDeploymentSecrets()` is called, **then** the platform generates a 32-byte hex secret if `work.platformSyncSecret` is empty, stores it encrypted, and returns `PLATFORM_SYNC_SECRET=<value>` in the secrets map so it lands as a GHA secret on the deployed site's repo (using the existing GHA-secrets push path — no new Vercel env-API code).

- **Existing-Work backfill**: **Given** a Work that was deployed before this feature shipped (no `PLATFORM_SYNC_SECRET` set yet), **when** the user next redeploys, **then** the secret is generated and pushed on that redeploy; until then, the feed shows the same degraded banner as in §2.2 but does not error.

- **Sync disabled**: **Given** a user toggles "Sync activity from deployed site" off in directory Settings, **when** the feed loads, **then** the deployed-site source is skipped and platform-internal + generation streams are shown without a degradation banner.

- **Tenant scoping**: **Given** a deployed directory site uses tenant scoping (the template is multi-tenant), **when** the platform calls the new internal endpoint, **then** only entries belonging to that site's tenant are returned, even if the underlying DB hosts multiple tenants.

## 3. Functional requirements

### 3.1 Tab and routing

- **FR-1**. The directory detail page MUST surface an "Activity Feed" tab between "Overview" and "Items". Tab label MUST be translatable via i18n key `dashboard.workDetail.tabs.activity`.
- **FR-2**. The tab MUST link to `/works/:id/activity` (constant `ROUTES.DASHBOARD_WORK_ACTIVITY`). The route MUST be a server component that hydrates a client feed component.
- **FR-3**. The existing `/works/:id/generator/history` route MUST remain functional and untouched in scope. Its tab label `tabs.history` is unrelated and unaffected.

### 3.2 Feed content

- **FR-4**. The feed MUST display events from three sources, merged into a single timeline ordered by event timestamp DESC:
  - **Platform activity-log** events filtered by `workId` (existing `GET /api/activity-log?workId=<id>`).
  - **Generation history** entries for this Work (existing `workAPI.getHistory(id)`).
  - **Deployed-site events** from the new internal endpoint (§3.5), gated by `work.platformSyncEnabled`.
- **FR-5**. Each entry MUST render: category icon, relative timestamp (with absolute on hover), one-line summary, primary action (deep-link or inline expand).
- **FR-6**. The feed MUST support pagination (cursor-based) with an initial page size of 25 entries.
- **FR-7**. The feed MUST offer filter chips for: **All** (default), **Generation**, **Items**, **Deployment**, **Settings**, **Comparisons**, **Community PR**, **Users** (deployed site), **Submissions** (deployed site), **Reports** (deployed site). The active filter MUST be reflected in the URL as `?category=<id>`.

### 3.3 Refresh and realtime

- **FR-8**. The feed MUST auto-poll every 5 seconds while the page is visible. Polling MUST pause when `document.hidden === true` and resume immediately on `visibilitychange` back to visible, with one immediate refresh on resume.
- **FR-9**. Auto-refresh MUST be silent — it MUST NOT remount visible rows or scroll the list.
- **FR-10**. The feed MUST offer a manual Refresh control. Manual refresh MUST behave identically to auto-refresh except it MUST also briefly show a spinner.
- **FR-11**. Concurrent requests MUST be deduplicated (only the latest in-flight result is rendered) using the same `requestIdRef` pattern as `activity-client.tsx`.
- **FR-12**. The feature MUST NOT introduce SSE, WebSocket, or any push channel. If the platform later gains one, the feed MAY adopt it as a follow-up.

### 3.4 Entry interaction

- **FR-13**. Clicking a generation-run entry MUST navigate to `/works/:id/generator/history?run=<runId>` (deep-link).
- **FR-14**. Clicking a platform activity-log entry MUST open `ActivityDetailModal` inline.
- **FR-15**. Clicking a deployed-site entry MUST open the deployed site's admin URL for that entity in a new tab. The URL pattern MUST be returned by the deployed site itself (§3.5) — the platform MUST NOT hardcode it.

### 3.5 Deployed-site internal endpoint

- **FR-16**. The `directory-web-template` repo MUST expose `GET /api/platform/activity-feed`. The endpoint MUST accept query params `since` (ISO-8601), `limit` (1–200, default 50), `types` (comma-separated subset of `users,items,reports,all`).
- **FR-17**. The endpoint MUST authenticate via two headers: `x-platform-ts: <ISO-8601>` and `x-platform-key: HMAC-SHA256(timestamp + ':' + query-string + ':' + tenantId, PLATFORM_SYNC_SECRET)`. Drift > 5 minutes MUST return `401`. Invalid HMAC MUST return `401`.
- **FR-18**. The endpoint MUST scope results to the caller's tenant (resolved from the `PLATFORM_SYNC_SECRET` lookup — one secret per directory site).
- **FR-19**. The endpoint MUST return normalized entries:
  ```
  {
    entries: Array<{
      id: string,
      type: 'user_registered' | 'item_created' | 'item_status_changed' | 'report_created',
      timestamp: string (ISO-8601),
      summary: string,
      actor: { id: string, name: string, email?: string } | null,
      target: { id: string, type: 'user'|'item'|'report', name: string, adminUrl: string }
    }>,
    nextCursor?: string,
    serverTime: string (ISO-8601)
  }
  ```
- **FR-20**. The endpoint MUST union three queries: `clientProfiles` newer than `since` (sign-ups), `itemAuditLogs` with action `CREATED` or `STATUS_CHANGED` (submissions and moderation transitions), `reports` (all statuses). Each source contributes at most `ceil(limit / count(activeTypes))` entries; the union is sorted timestamp DESC then truncated to `limit`.

### 3.6 Platform aggregator

- **FR-21**. The platform API MUST expose `GET /api/works/:id/activity-feed?since=&limit=&category=`. The endpoint MUST compose three sub-queries (platform activity-log filtered by `workId`, generation-history, optional deployed-site call) and return a single merged result with consistent shape (§3.5 schema, extended with platform-side fields).
- **FR-22**. The aggregator MUST cache responses in Redis for 30 seconds keyed by `workId + category + sinceBucket(60s)`. Cache MUST be invalidated when an `ActivityLogCreatedEvent` or `WorkGenerationCompletedEvent` for that Work is emitted (best-effort listener — staleness up to 30s is acceptable).
- **FR-23**. The aggregator MUST be authorised: only users who can read the Work (existing `WorkAccessGuard`) MUST be allowed.
- **FR-24**. When the deployed-site sub-call fails (timeout, 4xx, 5xx, DNS), the aggregator MUST still return the platform sources and add `degraded: { directorySite: { reason: '<short>' } }` to the response. `work.platformSyncLastError` MUST be updated.

### 3.7 Provisioning

- **FR-25**. The `Work` entity MUST gain these columns (TypeORM migration): `platformSyncSecretEncrypted` (text, nullable), `platformSyncEnabled` (boolean, default `true`), `platformSyncLastSuccessAt` (timestamptz, nullable), `platformSyncLastError` (text, nullable).
- **FR-26**. The encryption MUST reuse the platform's existing config-encryption key (the same key used for plugin-settings secrets) with AES-GCM.
- **FR-27**. The Vercel plugin (`packages/plugins/vercel/`) MUST implement `getDeploymentSecrets()` to return `{ PLATFORM_SYNC_SECRET: <decryptedSecret> }`. The secret MUST be lazily generated (32 random bytes hex) and persisted encrypted on first deploy if missing.
- **FR-28**. The platform MUST NOT call Vercel's project-env API directly. Secrets reach the deployed site through the existing GHA-secret push (`octokit.rest.actions.createOrUpdateRepoSecret`) and the deploy workflow MUST forward `PLATFORM_SYNC_SECRET` to the deployed Vercel project (template-side workflow change).
- **FR-29**. The Settings tab MUST gain a "Sync activity from deployed site" toggle bound to `work.platformSyncEnabled`. The toggle MUST default to `true` for new Works and existing Works.

### 3.8 Overview widget refresh

- **FR-30**. The existing `WorkActivity` widget on the Overview tab MUST be rewired from its current hardcoded mock to call the same aggregator (`GET /api/works/:id/activity-feed?limit=5`).
- **FR-31**. The widget MUST link to `/works/:id/activity` ("View all →"). If the aggregator returns zero entries, the widget MUST show the empty state.

## 4. Non-functional requirements

- **NFR-1**. The Activity Feed tab MUST render the first interactive frame in under 400 ms after the route hydrates, given a warm cache. Cold cache MUST stay under 1.2 s p95.
- **NFR-2**. The aggregator MUST complete within 800 ms p95 with the deployed-site sub-call timed out at 5 s. A timeout on the sub-call MUST NOT block the platform sources beyond 800 ms.
- **NFR-3**. The deployed-site internal endpoint MUST complete within 500 ms p95 for `limit ≤ 100`.
- **NFR-4**. The `PLATFORM_SYNC_SECRET` MUST never appear in any platform API response or in logs (including error logs). The HMAC signature MAY appear in trace logs.
- **NFR-5**. Polling load: with 100 concurrent open feeds, the aggregator MUST sustain 20 req/s without exceeding a single API replica's existing CPU budget. Redis cache hit rate MUST exceed 80% under that load.
- **NFR-6**. The migration adding the four `works` columns MUST be backwards-compatible: existing rows MUST be valid with all new columns NULL / default.
- **NFR-7**. Telemetry: PostHog events MUST fire for tab view, filter change, manual refresh, entry click, deployed-site degraded banner shown. Events MUST flow through the existing `AnalyticsService`, not a new client bundle.

## 5. Out of scope

- WebSocket / SSE realtime streaming (call out in `plan.md` as a future follow-up).
- A "mark as read" or notification badge system on the tab — the schema doesn't support per-user read state today.
- Member-related events (member invited, role changed) — the Members tab is currently removed from `WorkTabs.tsx`; member events stay in the platform activity-log but won't be filterable as a feed category until that surface returns.
- Cross-directory aggregation ("activity across all my Works") — the global `/activity` page already serves that need.
- Backfilling historical deployed-site events from before the secret was provisioned. The feed starts from when sync is first enabled per Work.
- Migrating `/generator/history` content into the new feed. The two surfaces stay independent.
- E-mail / Slack / push notifications triggered by feed events — separate spec.
- Exporting the feed to CSV — the existing `/activity-log/export` endpoint covers the global case and is reusable later.

## 6. Open questions

None as of 2026-05-12. All prior decisions resolved with owner:

- **One PR per repo** (no Phase 1 / Phase 2 split).
- **Keep `/generator/history`** as-is (complementary, not duplicate).
- **GHA-secrets path** for `PLATFORM_SYNC_SECRET` (no new Vercel env-API code).
- **5-second polling**, same pattern as the global `/activity` page (no SSE/WS).
- **Update EW-120 in place**; no sub-tickets.

## 7. Acceptance checklist

A reviewer can sign this spec off once they have confirmed each item:

- [ ] Every functional requirement maps to at least one user scenario in §2.
- [ ] The five Jira acceptance criteria (recent user registrations, recent item submissions, recent reports/flags, generation status, real-time-or-refresh, clickable entries) are covered by §3 FRs.
- [ ] The feed degrades safely when the deployed site is unreachable, with sync disabled, or before the secret is provisioned (FR-24, FR-25, §2.2 partial-degradation).
- [ ] `/generator/history` is explicitly kept and tested for non-regression.
- [ ] `PLATFORM_SYNC_SECRET` never leaks via API or logs (NFR-4).
- [ ] No new client-side analytics bundle is introduced (NFR-7).
- [ ] The new `works` columns are backfilled-compatible (NFR-6).
- [ ] Polling does not regress API CPU under 100 concurrent feeds (NFR-5).
