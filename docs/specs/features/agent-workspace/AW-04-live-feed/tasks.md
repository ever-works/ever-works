# AW-04 — Live Feed · Task breakdown

> Ordered work derived from [plan.md](./plan.md), behaviour from [spec.md](./spec.md).
> Every task carries explicit paths and a definition of "done". Execute top to bottom.

**Epic ID:** `AW-04-live-feed`
**Spec:** [./spec.md](./spec.md) · **Plan:** [./plan.md](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-09-06

---

## How to use

- Tasks are sequential unless marked `(parallel)`, which means they may land alongside the task
  immediately above them.
- `P1` / `P2` / `P3` mark the phase. Each phase is independently shippable and must leave `develop`
  green on its own.
- Every schema change ships its migration **in the same PR** (Constitution V). The migration task is
  not a follow-up.
- Formatting: tabs, width 4, 120 columns, single quotes, semicolons, no trailing commas (root
  Prettier config wins). Files are kebab-case; React components are PascalCase files.
- Run `pnpm format && pnpm lint && pnpm type-check` before every PR.

---

## Phase P1 — the feed, readable and paginated

### Contracts and data model

- [ ] **T1 · P1.** Add the feed contract types.
    - Create `packages/contracts/src/api/feed/feed-kind.ts` —
      `export type FeedKind = 'work' | 'decision' | 'delivery' | 'problem' | 'system';`
      plus `export const FEED_KINDS: readonly FeedKind[]`.
    - Create `packages/contracts/src/api/feed/feed.dto.ts` with `FeedActorDto`, `FeedNarrationDto`,
      `FeedEntryDto`, `FeedPageDto`, `FeedActorSummaryDto`, `FeedAwaySummaryDto` (shapes in
      [plan §3.4](./plan.md#34-contracts)).
    - Create `packages/contracts/src/api/feed/index.ts`; re-export from
      `packages/contracts/src/api/index.ts`.
    - **Done**: `pnpm --filter @ever-works/contracts build` emits declarations with no
      conditional-spread DTS failure; the new types are importable as `@ever-works/contracts`.

- [ ] **T2 · P1.** Add the actor columns to the activity record.
    - `packages/agent/src/entities/activity-log.entity.ts` — add `actorKind?` (`varchar(16)`,
      nullable), `actorAgentId?` (`uuid`, nullable, **no** `@ManyToOne` — see the Tier-C
      cycle-avoidance comment already on `tenantId`), `actorLabel?` (`varchar(120)`, nullable).
    - Add `@Index('idx_activity_log_user_actor_created', ['userId', 'actorAgentId', 'createdAt'])`
      and `@Index('idx_activity_log_user_created_id', ['userId', 'createdAt', 'id'])`.
    - `packages/agent/src/entities/activity-log.types.ts` — add the same three optional fields to
      `CreateActivityLogDto` (line 321) and add `actorAgentIds?: string[]`, `kinds?: FeedKind[]`,
      `failedOnly?: boolean`, `cursor?: { createdAt: Date; id: string }` to
      `ActivityLogQueryOptions` (line 335).
    - **Done**: all three are optional, every existing `ActivityLogService.log()` call site compiles
      untouched, `pnpm --filter @ever-works/agent type-check` is green.

- [ ] **T3 · P1.** Ship the migration for T2, in the same PR.
    - From `apps/api/`: `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddActivityLogFeedActor`
    - Rename the emitted file to `apps/api/src/migrations/1791040000000-AddActivityLogFeedActor.ts`
      (AW-04 slot 00, [README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow); re-stamp before merge if a newer migration has landed on `develop`).
    - Hand-edit both index statements to `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`
      and remove the migration's implicit transaction if the driver requires it.
    - **Done**: `up()` contains only `ADD COLUMN … NULL` and the two `CREATE INDEX`; there is no
      `DROP COLUMN`, no `NOT NULL`, no `UPDATE`/backfill; `down()` reverses exactly those; running
      the migration against a seeded local DB completes without locking `activity_log`.

### Narration and classification

- [ ] **T4 · P1.** Feed-kind mapper.
    - Create `packages/agent/src/activity-log/feed-kind.ts` exporting
      `resolveFeedKind(actionType, status): FeedKind` using the rules in
      [plan §2.5](./plan.md#25-feed-kinds) — the `problem` rule is evaluated **first**.
    - **Test**: `packages/agent/src/activity-log/feed-kind.spec.ts` — every one of the 162
      `ActivityActionType` members maps to exactly one kind (a table-driven test that fails if a new
      enum member is added without a mapping decision), and a `failed`/`cancelled` status overrides
      the cluster rule.
    - **Done**: no action type falls through to `undefined`; spec FR-17/FR-18 covered.

- [ ] **T5 · P1.** Narrator with 48 bespoke entries.
    - Create `packages/agent/src/activity-log/feed-narration.ts` exporting
      `narrate(activity): { key: string; params: Record<string, string | number> }` and a private
      table keyed by `ActivityActionType`. Each entry declares the `details`/`metadata` keys it may
      read; **reading any other key is impossible by construction**.
    - Include a `sanitizeNarrationParam(value)` helper: strip `<` and `>`, collapse newlines,
      truncate to 120 chars with `…` (mirrors `sanitizeLabel` in
      `packages/agent/src/notifications/notification.service.ts`).
    - Unknown action type → `{ key: 'fallback', params: { actor, action } }` where `action` is the
      humanised action type.
    - The 48 keys are listed in [plan §8](./plan.md#8-i18n) — keep the file's order identical to that
      list so the two are diffable.
    - **Test**: `packages/agent/src/activity-log/feed-narration.spec.ts` — one case per entry; an
      unknown type returns `fallback`; a `details` value containing `<script>` comes back stripped; a
      200-char value comes back at 120 + `…`; a `details` key not on the entry's allow-list never
      appears in `params`.
    - **Done**: spec FR-14/FR-15/FR-16 covered; the file exports no English string.

### Read model

- [ ] **T6 · P1.** Keyset reads on the repository.
    - `packages/agent/src/database/repositories/activity-log.repository.ts` — add
      `findFeedPage(options)` (keyset `WHERE userId = :uid AND (createdAt, id) < (:t, :i)`,
      `ORDER BY createdAt DESC, id DESC`, `LIMIT :n + 1` to derive `hasMore`), `countSince(userId, scope, since)`,
      `aggregateActors(userId, scope, since)` and `aggregateAwayCounts(userId, scope, since, cap)`.
    - Every method applies `userId` **and** the active organization scope; none accepts a caller-supplied
      user id.
    - **Test**: `packages/agent/src/database/repositories/activity-log.repository.feed.spec.ts` —
      asserts the generated query shape for the keyset predicate, the agent filter, the kind filter
      and the scope filter.
    - **Done**: no `OFFSET` anywhere in the new methods.

- [ ] **T7 · P1.** `FeedService`.
    - Create `packages/agent/src/activity-log/feed.service.ts` with `getPage(userId, scope, filters)`,
      `getActors(userId, scope, windowHours)`, `encodeCursor` / `decodeCursor` (base64url of
      `{t, i}`), the 5-rung actor-resolution ladder ([plan §2.4](./plan.md#24-actor-resolution))
      including the batched agent lookup for legacy rows, and `resolveHref(activity)`
      ([plan §5.5](./plan.md#55-destination-resolution-href)) built from `ROUTES`-equivalent
      constants held server-side.
    - Register in `packages/agent/src/activity-log/activity-log.module.ts` (providers + exports) and
      export from `packages/agent/src/activity-log/index.ts`.
    - **Test**: `packages/agent/src/activity-log/feed.service.spec.ts` — cursor round-trip; a
      malformed cursor throws the typed error; ordering stays stable when a row is inserted at the
      head between two page reads; all 5 actor rungs; `href` precedence order; the 20-agent cap.
    - **Done**: spec FR-2/FR-12/FR-19/FR-46 covered.

### API

- [ ] **T8 · P1.** Request DTOs.
    - Create `apps/api/src/activity-log/dto/feed-query.dto.ts` (`agentIds` — transformed from csv,
      `@ArrayMaxSize(20)`, `@IsUUID('4', { each: true })`; `kinds` — `@IsIn(FEED_KINDS, { each: true })`;
      `failedOnly` — `@IsBooleanString()`; `cursor` — `@IsString()` `@MaxLength(256)`; `limit` —
      `@IsInt()` `@Min(1)` `@Max(50)`, default 30) and
      `apps/api/src/activity-log/dto/feed-actors-query.dto.ts` (`windowHours` 1-720, default 168).
    - **Done**: over-limit `agentIds` produces `400 { error: 'too-many-agents', max: 20 }`, not a
      silent truncation (spec FR-38).

- [ ] **T9 · P1.** `FeedController` — page and actors.
    - Create `apps/api/src/activity-log/feed.controller.ts`, `@Controller('api/feed')`,
      `@UseGuards(AuthSessionGuard)`, `@ApiTags('Live Feed')`, `@ApiBearerAuth('JWT-auth')`.
    - `GET /` → `FeedPageDto` (`@Throttle` 120/min); `GET /actors` → `{ actors }` (60/min).
    - Scope is read from `ScopeContextService` — **never** from a query parameter. Follow the
      reasoning documented in `apps/api/src/digest/digest.controller.ts`.
    - Register the controller in `apps/api/src/activity-log/activity-log.module.ts` (do **not** create
      a new module — one store, one module).
    - Add `@ApiOperation` / `@ApiResponse` on both handlers.
    - **Done**: `GET /api/feed` returns 401 unauthenticated, 400 on a bad cursor, and never returns a
      row belonging to another user or another organization.

- [ ] **T10 · P1.** Controller spec (P1 subset).
    - Create `apps/api/src/activity-log/feed.controller.spec.ts` modelled on the existing
      `apps/api/src/activity-log/activity-log.controller.spec.ts`.
    - Cases: auth required; limit clamped to 50; `400 invalid-cursor`; `400 too-many-agents`; scope
      taken from `ScopeContextService` and ignored when supplied in the query; an out-of-scope
      record id returns the same response as a non-existent one (spec FR-59).
    - **Done**: `cd apps/api && pnpm test -- feed.controller` green.

### Web

- [ ] **T11 · P1.** Typed client and server actions.
    - Create `apps/web/src/lib/api/feed.ts` (`feedAPI.page()`, `.actors()`) using `serverFetch` from
      `./server-api`, attaching `X-Scope-Slug` — mirror `apps/web/src/lib/api/activity-log.ts`.
    - Create `apps/web/src/app/actions/feed.ts` with auth-guarded `getFeedPage` / `getFeedActors`,
      mirroring `apps/web/src/app/actions/activity-log.ts`.
    - **Done**: both are server-only; no API token can reach a client bundle.

- [ ] **T12 · P1.** Route constant and navigation.
    - `apps/web/src/lib/constants.ts` — add `DASHBOARD_FEED: '/feed'` next to
      `DASHBOARD_ACTIVITY` (line 110).
    - `apps/web/src/components/dashboard/DashboardSidebar.tsx` — insert the nav item immediately
      **above** the existing activity item (line 198), label
      `t('navigation.feed')`, icon `Radio` from `lucide-react`.
    - **Done**: `/activity` is unchanged in position, label and behaviour.

- [ ] **T13 · P1.** Page shell and client.
    - Create `apps/web/src/app/[locale]/(dashboard)/feed/page.tsx` — RSC shell; parallel-fetch page 1
      and the actor roster; export `generateMetadata` reading `metadata.pages.feed`.
    - Create `apps/web/src/app/[locale]/(dashboard)/feed/feed-client.tsx` — `'use client'`; owns
      filter state, entry list, selection, and the URL sync block (mirror the `router.replace`
      pattern at `activity-client.tsx:111-123`).
    - **Done**: first paint renders real rows server-side, not a skeleton.

- [ ] **T14 · P1.** Feed components.
    - Create under `apps/web/src/components/feed/`: `FeedList.tsx`, `FeedRow.tsx`,
      `FeedKindPill.tsx`, `FeedFilters.tsx`, `FeedAgentPicker.tsx`, `FeedEmptyState.tsx`,
      `FeedErrorState.tsx`, `FeedEndCard.tsx`, `FeedSkeleton.tsx`.
    - Copy comes only from `useTranslations('dashboard.feed')`. `FeedKindPill` always renders a text
      label alongside its colour. `FeedSkeleton` rows are the same height as `FeedRow` so nothing
      shifts on hydration.
    - `FeedRow` renders `t(\`narration.${entry.narration.key}\`, entry.narration.params)` and falls
      back to `narration.fallback` if the key is missing.
    - **Done**: wireframes and copy in [spec §6.2, §6.5, §6.6, §6.7, §6.8, §6.9](./spec.md#6-ux)
      are reproduced exactly.

- [ ] **T15 · P1.** Paging hook and the floors.
    - Create `apps/web/src/lib/hooks/use-feed-paging.ts` — cursor state, dedupe by entry id,
      `IntersectionObserver` with `rootMargin: '400px'`, a real **Load older** button for keyboard
      users, and the two stops: 20 pages per visit and 90 days.
    - **Done**: spec FR-44/45/46/48 covered; no page-number control exists anywhere in the UI.

- [ ] **T16 · P1.** Keyboard affordances.
    - In `feed-client.tsx`, bind `j`, `k`, `Enter`/`o`, `Esc`, `a`, `1`–`5`, `x`, `Shift+L` per
      [spec §6.10](./spec.md#610-keyboard), active only when no input has focus.
    - Add `role="feed"` on the list with `aria-busy` during loads, and `role="separator"` readiness
      for the P2 divider.
    - **Done**: the whole P1 flow is completable with no mouse.

- [ ] **T17 · P1.** i18n — English.
    - `apps/web/messages/en.json` — add the full `dashboard.feed` namespace from
      [plan §8](./plan.md#8-i18n), plus `dashboard.sidebar.navigation.feed` and
      `metadata.pages.feed`. Values are the copy table in
      [spec §6.9](./spec.md#69-exact-user-visible-copy).
    - **Every leaf name is camelCase and contains no literal `.`** — a dot in a leaf makes next-intl
      throw at runtime and reds several e2e shards at once.
    - **Done**: `dashboard.feed.narration` has exactly 48 keys plus `fallback`.

- [ ] **T18 · P1** (parallel with T17). i18n — the other 20 locales.
    - Run `pnpm --filter web translate:messages`, then review
      `apps/web/messages/{ar,bg,de,es,fr,he,hi,id,it,ja,ko,nl,pl,pt,ru,th,tr,uk,vi,zh}.json`.
    - **Done**: a key-set diff against `en.json` is empty for all 20 files.

### P1 tests

- [ ] **T19 · P1.** Web unit specs.
    - `apps/web/src/components/feed/FeedRow.unit.spec.tsx` — narration key + params render; a
      missing `href` renders plain text, not a link; the kind pill always carries text.
    - `apps/web/src/lib/hooks/use-feed-paging.unit.spec.ts` — no duplicate ids across pages; both
      floors stop the loader.
    - **Done**: `cd apps/web && pnpm test` green.

- [ ] **T20 · P1.** e2e — filters and paging.
    - `apps/web/e2e/feed-filters-paging.spec.ts` covering spec S4, S5, S8, S12, S15: agent chip
      filter + URL round-trip + reload persistence; the 21st-agent refusal message; three
      auto-loaded pages with no repeated entry; **Only failed**; the filtered-empty state; the
      terminal card.
    - **Done**: green headless and in CI.

- [ ] **T21 · P1.** e2e — empty and error.
    - `apps/web/e2e/feed-empty-and-error.spec.ts` covering S11 and S13, including both call-to-action
      buttons on the never-any state and both actions on the error state.

- [ ] **T22 · P1.** Regression guard.
    - Run `apps/web/e2e/activity-log.spec.ts`, `activity-log-export.spec.ts`,
      `activity-log-audit.spec.ts` and the `flow-activity-*.spec.ts` suite unchanged.
    - **Done**: all pass with no edits — the proof that `/activity` was not disturbed
      ([spec §7](./spec.md#7-out-of-scope)).

---

## Phase P2 — live, seen, and the emission gaps

### The event and the stream

- [ ] **T23 · P2.** The `activity.logged` event.
    - Create `packages/agent/src/events/activity-logged.event.ts` —
      `ActivityLoggedEvent extends BaseEvent`, `static EVENT_NAME = 'activity.logged'`, carrying the
      persisted `ActivityLog`.
    - Export from `packages/agent/src/events/index.ts`.
    - `packages/agent/src/activity-log/activity-log.service.ts` — add
      `@Optional() @Inject(EventEmitter2)` to the constructor (line 24-31) and a private
      `dispatchFeedEvent(activity)` called from `log()` (line 95) right after
      `dispatchAnalytics(activity)`. It must be a no-op when the emitter is not bound — copy the
      posture of `NotificationService.dispatchFanout()`.
    - **Test**: extend `packages/agent/src/activity-log/activity-log.service.spec.ts` — `log()`
      emits once; no emitter bound is a silent no-op; a throwing listener does not fail `log()`.
    - **Done**: no existing agent-package unit test needs a new module import.

- [ ] **T24 · P2.** Stream registry.
    - Create `apps/api/src/activity-log/feed-stream.registry.ts` — `Map<userId, Set<Subscriber>>`,
      `subscribe()` refusing a 4th concurrent connection per user, per-connection emitted-id `Set`
      capped at 2,000 with FIFO eviction, and filter matching (agents / kinds / failedOnly).
    - **Test**: `apps/api/src/activity-log/feed-stream.registry.spec.ts` — subscribe/unsubscribe,
      the 4th-connection refusal, dedupe, the cap, filter matching.

- [ ] **T25 · P2.** Stream listener.
    - Create `apps/api/src/activity-log/feed-stream.listener.ts` — `@OnEvent('activity.logged',
      { async: true, suppressErrors: true })`, narrates and pushes to matching subscribers.
    - **Test**: `apps/api/src/activity-log/feed-stream.listener.spec.ts` — only matching subscribers
      receive; a listener error is suppressed and never surfaces to the writer.

- [ ] **T26 · P2.** SSE endpoint.
    - Add `GET /stream` to `apps/api/src/activity-log/feed.controller.ts`, modelled line-for-line on
      `apps/api/src/email/email.controller.ts:178-255`: `text/event-stream` +
      `no-cache, no-transform` + `keep-alive` + `flushHeaders()`; `: ping` every 15 s; safety poll
      every 15 s; a 10-minute lifetime cap that calls `cleanup()` and `res.end()`; `cleanup()` also
      bound to `req.on('close')`, `res.on('close')` and `req.socket?.on('close')`.
    - Emit named `feed` events with `id:` set to the entry id so `Last-Event-ID` resumes on
      reconnect. `@Throttle` 12/min.
    - **Done**: killing a connection abruptly leaves no timer running (assert in the registry spec);
      a 4th concurrent connection gets `429` with `Retry-After: 30`.

- [ ] **T27 · P2.** Web BFF proxy for the stream.
    - Create `apps/web/src/app/api/feed/stream/route.ts` — `export const dynamic = 'force-dynamic'`,
      read the auth cookie with `getAuthAccessCookie()`, forward as a bearer to
      `${API_URL}/feed/stream`, pipe `upstream.body`. Near-copy of
      `apps/web/src/app/api/email/messages/stream/route.ts`.
    - **Done**: the auth token never appears in a client bundle or a client-visible response.

- [ ] **T28 · P2.** Stream hook with fallback and tab leadership.
    - Create `apps/web/src/lib/hooks/use-feed-stream.ts` — `EventSource` against the BFF; backoff
      1 s → 30 s with ±20% jitter; after 3 failures fall back to a 10 s refresh; leadership via
      `BroadcastChannel('ever-works-feed')` plus a `localStorage` lease `feed-stream-leader`
      (renewed every 5 s, taken over after a 12 s stale lease); followers receive relayed entries;
      no `BroadcastChannel` → every tab uses the 10 s poll.
    - **Test**: `apps/web/src/lib/hooks/use-feed-stream.unit.spec.ts` — backoff schedule and jitter
      bounds; the 3-failure fallback; lease acquire / renew / take-over.
    - **Done**: spec FR-4/6/7/8/9 and S9/S10 covered.

- [ ] **T29 · P2.** Queue pill and the connection banner.
    - Create `apps/web/src/components/feed/FeedNewPill.tsx` and
      `apps/web/src/components/feed/FeedConnectionBanner.tsx`; wire into `feed-client.tsx`.
    - Queue when scrolled > 200 px from the top; cap the queue at 200 entries; the pill reads `99+`
      beyond 99; `t` and clicking both scroll to top and release.
    - **Done**: spec FR-49/50/51/52 and S6 covered; the list never shifts under a reader.

### Seen state and the away summary

- [ ] **T30 · P2.** `FeedReadState` entity.
    - Create `packages/agent/src/entities/feed-read-state.entity.ts` per
      [plan §3.3](./plan.md#33-new-entity-feedreadstate-p2), including both partial unique indexes
      (`uq_feed_read_state_user_org` and `uq_feed_read_state_user_no_org`).
    - Export from `packages/agent/src/entities/index.ts`.
    - Create `packages/agent/src/database/repositories/feed-read-state.repository.ts` with a
      `getOrCreate` and a monotonic `advance`.
    - **Test**: `packages/agent/src/database/repositories/feed-read-state.repository.spec.ts`.

- [ ] **T31 · P2.** Migration for T30, in the same PR.
    - `apps/api/src/migrations/1791040100000-CreateFeedReadState.ts` (AW-04 slot 01) — `CREATE TABLE`, the FK to
      `users` with `ON DELETE CASCADE`, and the two partial unique indexes.
    - **Done**: forward-only; `down()` drops only the table and its indexes.

- [ ] **T32 · P2.** `FeedReadStateService`.
    - Create `packages/agent/src/activity-log/feed-read-state.service.ts` — `getState`,
      `markSeen({ upToActivityId, upToCreatedAt })` (**monotonic**: a request to move backwards
      succeeds and does nothing), `countUnseen`, `dismissAwaySummary`.
    - Register in `packages/agent/src/activity-log/activity-log.module.ts`, export from the barrel.
    - **Test**: `packages/agent/src/activity-log/feed-read-state.service.spec.ts` — lazy create;
      backwards write is a no-op; per-organization isolation; dismiss and re-arm.
    - **Done**: spec FR-21/24/25/27/34 covered.

- [ ] **T33 · P2.** Away-summary service.
    - Create `packages/agent/src/activity-log/feed-away-summary.service.ts` — the 30-minute and
      ≥1-unseen gates, the 7-day window clamp, the 1,000-row scan cap with a `truncatedToScanCap`
      flag, counts by kind, top 5 actors plus the remainder, decisions waiting, failures, all inside
      a 3-second budget. Follows the deterministic-first, degrade-with-a-reason posture of
      `packages/agent/src/digest/digest.service.ts`.
    - **Test**: `packages/agent/src/activity-log/feed-away-summary.service.spec.ts` — both gates,
      the clamp, the cap flag, the remainder count, the zero-window `{ shown: false }` branch, the
      timeout branch.
    - **Done**: spec FR-28..FR-35 covered.

- [ ] **T34 · P2.** API endpoints for seen and the summary.
    - `apps/api/src/activity-log/dto/feed-seen.dto.ts` — `upToActivityId?` (`@IsUUID`),
      `upToCreatedAt?` (`@IsISO8601`), at least one required.
    - `apps/api/src/activity-log/feed.controller.ts` — add `POST /seen` (60/min),
      `GET /away-summary` (20/min), `POST /away-summary/dismiss` (30/min, `204`).
    - Extend `apps/api/src/activity-log/feed.controller.spec.ts` with the new cases, including that
      `POST /seen` is idempotent and monotonic.

- [ ] **T35 · P2.** Web plumbing for seen and the summary.
    - Extend `apps/web/src/lib/api/feed.ts` and `apps/web/src/app/actions/feed.ts`.
    - Create the client-callable BFF routes `apps/web/src/app/api/feed/seen/route.ts` and
      `apps/web/src/app/api/feed/away-summary/dismiss/route.ts` — thin cookie-forwarding proxies,
      same shape as `apps/web/src/app/api/activity-log/[id]/route.ts`.
    - Create `apps/web/src/lib/hooks/use-feed-seen.ts` — the three-condition advance rule (tab
      visible **and** feed focused ≥ 3 s **and** newest entry in the viewport), throttled to once per
      2 s, plus `Mark all seen` and cross-tab sync over the same `BroadcastChannel`.
    - **Test**: `apps/web/src/lib/hooks/use-feed-seen.unit.spec.ts`.

- [ ] **T36 · P2.** Divider, badge and away card.
    - Create `apps/web/src/components/feed/FeedDivider.tsx` (sticky, `role="separator"`, anchored to
      the `lastSeenAt` captured at page load and **not** moved as the watermark advances),
      `apps/web/src/components/feed/AwaySummaryCard.tsx` (all four states: normal, truncated,
      failed, dismissed — every number is a control that filters the feed), and
      `apps/web/src/components/dashboard/SidebarFeedBadge.tsx` (exact ≤ 99 then `99+`, refreshed at
      most every 30 s, reading the open stream's count when this tab holds it).
    - Wire the badge into `DashboardSidebar.tsx` beside the item added in T12.
    - **Test**: `apps/web/src/components/feed/AwaySummaryCard.unit.spec.tsx`.
    - **Done**: spec FR-22/23/26/32 and S2/S3 covered.

### Closing the emission gaps

- [ ] **T37 · P2.** New run action types.
    - `packages/agent/src/entities/activity-log.types.ts` — append `AGENT_RUN_STARTED`,
      `AGENT_RUN_COMPLETED`, `AGENT_RUN_FAILED` with a comment stating that `actionType` is a plain
      `varchar(50)`, so **no migration is required**, and that the three `agent_heartbeat_*` members
      are unchanged.
    - Add the three to the T4 kind map and the T5 narrator (they are already in the 48).
    - **Done**: `pnpm --filter @ever-works/agent test` green; the Activity page's existing type
      filter is unaffected.

- [ ] **T38 · P2.** Emit run start and terminal records for all 5 trigger kinds.
    - `packages/agent/src/agents/agent-run.service.ts`:
        - in `execute()` (line 247), emit `AGENT_RUN_STARTED` with
          `actorKind: 'agent'`, `actorAgentId`, `actorLabel` (the agent's current `name`) and
          `details.runId` / `details.triggerKind`;
        - in `finalize()` (line 1474), widen the existing `context.kind === 'heartbeat'` gates
          (lines ~1512 and ~1541) so heartbeat keeps `AGENT_HEARTBEAT_COMPLETED` /
          `AGENT_HEARTBEAT_FAILED` and the other four kinds (`manual`, `task`, `chat`, `event`) emit
          `AGENT_RUN_COMPLETED` / `AGENT_RUN_FAILED`;
        - extend `logActivity()` (lines 2155-2188) to accept and pass through the three actor fields.
    - Idempotency: set a deterministic `ingestEventId` of `run:${runId}:${phase}` on every emit so a
      worker retry cannot produce a second feed entry (spec FR-56).
    - Scope: stamp `userId`, `tenantId` and `organizationId` from the agent being run, since these
      emits happen outside a request context (spec FR-55).
    - **Test**: `packages/agent/src/agents/__tests__/agent-run-feed-activity.spec.ts` — one record
      per terminal state for each of the 5 trigger kinds; heartbeat still uses the heartbeat action
      types; a repeated `finalize()` writes exactly one record.
    - **Done**: spec FR-53/54/55/56 covered.

- [ ] **T39 · P2** (parallel with T38). Actor stamping at the other high-value writers.
    - Add `actorKind` / `actorAgentId` / `actorLabel` to the `ActivityLogService.log()` calls that
      already know the acting agent, starting with `packages/agent/src/agents/agent-export.service.ts`
      (line ~803), `apps/api/src/agents/agents.controller.ts` (line ~1626) and
      `apps/api/src/agents/agent-collaborators.controller.ts` (line ~216).
    - **Done**: `feed.narration.fallbackRate` and the read-time actor ladder are measurably less
      loaded; no call site's behaviour changes otherwise.

### P2 tests

- [ ] **T40 · P2.** e2e — live.
    - `apps/web/e2e/feed-live.spec.ts` covering S1, S9, S10: a written record appears within 5 s;
      the reconnecting banner; the degraded banner after 3 failures; no duplicates after recovery;
      the second-tab notice.

- [ ] **T41 · P2.** e2e — seen and away.
    - `apps/web/e2e/feed-seen-divider.spec.ts` (S2, S3, S16) and
      `apps/web/e2e/feed-away-summary.spec.ts` (S2, S14).

- [ ] **T42 · P2.** e2e — scope isolation and accessibility.
    - `apps/web/e2e/feed-scope-isolation.spec.ts` (S18) and `apps/web/e2e/feed-a11y.spec.ts`
      (full keyboard flow per [spec §6.10](./spec.md#610-keyboard) plus an axe pass with zero
      serious or critical violations).

- [ ] **T43 · P2.** Telemetry.
    - Emit the client signals (`feed_opened`, `feed_marked_seen`, `feed_filter_changed`,
      `feed_page_loaded`, `feed_stream_state`) and the API gauges (`feed.stream.*`, `feed.push.latencyMs`,
      `feed.poll.caughtCount`, `feed.narration.fallbackRate`) through `packages/monitoring/`.
    - Add the Sentry tags `feature:aw-04-live-feed`, `feed.kind`, `feed.actorKind`.
    - **Done**: [plan §9.1](./plan.md#91-telemetry) fully wired; **no** new `ActivityActionType` is
      added for the feed's own use (spec FR-57).

---

## Phase P3 — polish and what other epics need

- [ ] **T44 · P3.** Optional written narrative, dispatched.
    - Create `packages/agent/src/tasks/feed-away-summary-dispatcher.ts` —
      `export const FEED_AWAY_SUMMARY_DISPATCHER = Symbol('FEED_AWAY_SUMMARY_DISPATCHER')` plus the
      dispatcher interface.
    - Create `packages/tasks/src/tasks/trigger/feed-away-summary.task.ts` and register it in
      `packages/tasks/src/tasks/trigger/index.ts`.
    - The model call goes through `packages/agent/src/facades/ai.facade.ts` only, capped at 1,200
      characters / 400 tokens, degrading to counts-only with a visible reason.
    - Idempotency key: `feed-away:${userId}:${organizationId ?? 'none'}:${windowStartEpoch}`.
    - `GET /api/feed/away-summary` returns counts immediately with
      `narrative: null, narrativeStatus: 'queued'`; the card polls once after 3 s.
    - The card footer shows the model and token cost that produced the paragraph
      (`dashboard.feed.away.narrativeCost`), per program rule #9.
    - **Done**: no call site imports `@trigger.dev/sdk`; the feature is **off by default**
      (spec FR-36).

- [ ] **T45 · P3.** Compact feed block for Home.
    - Export a `CompactFeed` from `apps/web/src/components/feed/CompactFeed.tsx` — same rows, page
      size 8, no filters, no divider, a "See all" link to `/feed`.
    - **Done**: [AW-19](../AW-19-home/) can import it without touching feed internals; the open
      question in [spec §9](./spec.md#9-open-questions) about which entries it shows is resolved
      before this task starts.

- [ ] **T46 · P3.** Narration coverage beyond 48.
    - Read `feed.narration.fallbackRate` from production, rank the uncovered action types by
      frequency, and add narrator entries + i18n keys in that order.
    - **Done**: fallback rate below 10% of rendered entries.

- [ ] **T47 · P3.** Shortcut sheet handover.
    - Register the feed's shortcuts with [AW-01](../AW-01-command-palette/)'s `?` sheet rather than
      duplicating a local overlay.

- [ ] **T48 · P3.** Attention hooks for AW-13.
    - Expose the feed-kind classification and the unseen count as a stable internal contract that
      [AW-13](../AW-13-attention-controls/) can build the notification matrix on, so the two do not
      each grow their own copy of the mapping.

---

## Docs and rollout

- [ ] **T49.** User-facing documentation.
    - Create `docs/features/live-feed.md`; add `'features/live-feed'` to
      `apps/docs/sidebarsPlatform.ts` immediately above the existing `'features/activity'` entry
      (line 98); cross-link from `docs/features/activity.md`.
    - **Done**: `pnpm --filter ever-works-docs build` produces no broken-link warnings.

- [ ] **T50.** Tracker and status.
    - Update `docs/specs/features/agent-workspace/TRACKER.md` — set AW-04's **Spec** column to
      `Draft` on this PR, then to the implementation state as each phase lands.
    - Set this file's and `plan.md`'s status to `Done`, and `spec.md`'s to `Implemented`, only after
      P2 lands.

- [ ] **T51.** Full gate.
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the repo root.
    - `cd apps/web && pnpm test:e2e` for the 7 new feed specs plus the activity regression suite.

---

## Definition of done

- Every checkbox above ticked for the phase being shipped.
- Every functional requirement in [spec §4](./spec.md#4-functional-requirements) has at least one
  passing automated test.
- Every acceptance criterion in [spec §8](./spec.md#8-acceptance-criteria) verified by hand once and
  by a test thereafter.
- Both migrations applied cleanly on a copy of production-shaped data, with no lock held on
  `activity_log` for longer than a metadata change.
- `/activity` behaves identically to `develop` — proved by T22.
- All 21 message files carry the identical `dashboard.feed` key set, with no literal `.` in any leaf.
- Constitution gates in [plan §12](./plan.md#12-constitution-compliance) re-confirmed at review time.
