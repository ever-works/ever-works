# AW-18 — Task Breakdown: Shared read-only views & channel guests

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each task is small
> enough to land in one PR and ships with tests
> ([Constitution VI](../../../../../.specify/memory/constitution.md#vi-tests-are-a-prerequisite-not-a-follow-up)).

**Feature ID**: `aw-18-shared-dashboards`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06
**Blocking dependency**: [AW-02 Task board](../AW-02-task-board/spec.md) must have
landed its Focus-layout column projection before **T9**.

---

## How to use

- Tasks are sequential unless marked `(parallel)`.
- Every task names the exact files to create or modify and what "done" means.
- Add new tasks at the bottom rather than renumbering.
- Standing rules for every task in this list:
    - Run `pnpm lint && pnpm type-check` before opening the PR.
    - A TypeORM entity change **must** carry its migration in the same PR
      (Constitution V).
    - Every user-visible string is an i18n key with a **camelCase leaf name containing
      no literal dot** — next-intl rejects dotted leaf names at runtime.
    - New endpoints answer `404`, never `403`, for an unentitled caller.

---

## Phase 1 — Publish (P1)

Ships FR-1…FR-24 and FR-34…FR-49. The Knowledge toggle renders disabled until P3.

### Data model & contracts

- [ ] **T1**. Add the `SharedView` entity.
    - Create `packages/agent/src/entities/shared-view.entity.ts` with the columns in
      [`plan.md` §3.1](./plan.md#31-new-entity--sharedview): `organizationId` (unique),
      `tenantId`, `ownerUserId`, `tokenHash` (unique), `tokenEncrypted`
      (`EncryptedJsonColumn()` from
      `packages/agent/src/entities/_secret-json-column.ts`), `status`, `sections`,
      `knowledgeClasses`, `searchIndexable`, `viewCount`, `lastViewedAt`,
      `firstViewNotifiedAt`, `tokenRotatedAt`, `rotationCount`, `createdById`,
      timestamps.
    - Export from `packages/agent/src/entities/index.ts`.
    - Register in `packages/agent/src/database/_entities-inventory.ts` **and**
      `packages/agent/src/database/_entity-names.ts` (alphabetical insertion) — this repo
      has no `autoLoadEntities`, and a drift spec fails CI if either is missed.
    - **Test**: `packages/agent/src/entities/__tests__/shared-view.entity.spec.ts` —
      asserts the default `sections` shape, `knowledgeClasses` defaults to `[]`,
      `searchIndexable` defaults to `false`, `status` defaults to `'active'`.
    - **Done when**: `cd packages/agent && pnpm test` passes and the entity-name drift
      spec in `packages/agent/src/database/__tests__/` is green.

- [ ] **T2**. Write the migration for `shared_views`.
    - Create `apps/api/src/migrations/1791180000000-CreateSharedViews.ts` (generate with
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateSharedViews`
      from `apps/api/`, then hand-check it).
    - Must create the table plus `UNIQUE(organizationId)`, `UNIQUE(tokenHash)` and
      `INDEX(tenantId)`, with `ON DELETE CASCADE` on the organization FK.
    - **Done when**: the SQL is purely additive (no `DROP`, no `ALTER … TYPE`), `down()`
      drops only the table and its indexes, and a fresh boot with `RUN_MIGRATIONS=true`
      applies it cleanly.

- [ ] **T3** (parallel with T2). Add the published contracts.
    - Create `packages/contracts/src/api/shared-view/` with `shared-view.dto.ts`,
      `published-board.dto.ts`, `published-document.dto.ts`, `publishable-activity.ts`
      and `index.ts`.
    - Declare `SharedViewSettingsDto`, `SharedViewSectionsDto`,
      `SharedViewIndexingMode`, `PublishedBoardDto`, `PublishedColumnDto`,
      `PublishedTaskCardDto`, `PublishedAgentDto`, `PublishedActivityLineDto`,
      `PublishedDocumentSummaryDto`, `PublishedDocumentDto`, and the frozen
      `PUBLISHABLE_ACTIVITY_ACTIONS` constant.
    - Every published DTO is **closed**: no index signature, no `Record<string, unknown>`.
    - Re-export from `packages/contracts/src/api/index.ts`.
    - **Done when**: `turbo build --filter=@ever-works/contracts` succeeds and the
      declaration output contains no `[key: string]` on any `Published*` type.

### Token, projection and publish filters

- [ ] **T4**. Add the share-token service.
    - Create `packages/agent/src/shared-views/shared-view-token.service.ts`: 256-bit
      generation via `node:crypto`, URL-safe encoding, `sha256` hash, and the
      encrypt/decrypt round trip through the entity column.
    - **Test**: `packages/agent/src/shared-views/__tests__/shared-view-token.spec.ts` —
      43-character output, hash stability, round-trip equality, and an assertion that a
      serialised entity never contains the raw token.
    - **Done when**: the spec passes and `grep` finds no path that logs the token.

- [ ] **T5**. Add the publish filters (the security boundary).
    - Create `packages/agent/src/shared-views/publish-filter.ts` exporting pure functions
      `publishTaskCard`, `publishAgent`, `publishActivityLine`,
      `publishDocumentSummary`, `publishDocument`.
    - **Test**: `packages/agent/src/shared-views/__tests__/publish-filter.spec.ts` —
      asserts the **exact key set** of each output object, and feeds each filter an input
      carrying `costUsd`, `budget`, `tokenCount`, `model`, `instructions`, `comments`,
      `repoUrl`, `email` and the Task's owner columns (`missionId`, `workId`, `ideaId`,
      `teamId`, `agentId`, `goalId`) and asserts none survives — the shared view
      publishes no provenance chip (FR-21).
    - **Done when**: adding a field to `Task` and re-running the spec fails until the
      field is deliberately classified.

- [ ] **T6**. Classify every activity action for publication.
    - Create `packages/agent/src/shared-views/publishable-activity.ts` with
      `PUBLISHABLE_ACTIVITY_ACTIONS` and `NEVER_PUBLISH_ACTIVITY_ACTIONS`.
    - **Test**: `packages/agent/src/shared-views/__tests__/publishable-activity.spec.ts` —
      iterates every member of `ActivityActionType`
      (`packages/agent/src/entities/activity-log.types.ts`) and fails if any member is on
      neither list.
    - **Done when**: the spec is green, and adding a new action type without classifying
      it turns CI red.

- [ ] **T7**. Add the `SharedView` repository.
    - Create `packages/agent/src/database/repositories/shared-view.repository.ts` with
      `findByOrganization`, `findByTokenHash` (single indexed read),
      `createForOrganization`, `rotateToken` (atomic `UPDATE … WHERE rotationCount = :seen`),
      `updateSettings`, `applyViewDelta`.
    - Register in `packages/agent/src/database/_repository-inventory.ts` if
      `DatabaseModule` owns it, otherwise export it from the feature module and from
      `packages/agent/src/database/index.ts`.
    - **Test**: `packages/agent/src/database/repositories/__tests__/shared-view.repository.spec.ts`
      — covers the optimistic-concurrency loser path.
    - **Done when**: the DatabaseModule drift spec in
      `packages/agent/src/database/database.module.spec.ts` stays green.

- [ ] **T8**. Add the `SharedView` domain service.
    - Create `packages/agent/src/shared-views/shared-view.service.ts` and
      `packages/agent/src/shared-views/shared-views.module.ts`.
    - Methods: `getForOrganization`, `enable`, `disable`, `regenerate` (resets
      `firstViewNotifiedAt` to `NULL`, increments `rotationCount`), `updateSettings`,
      `deleteForOrganization`, `resolveByToken`.
    - **Test**: `packages/agent/src/shared-views/__tests__/shared-view.service.spec.ts` —
      enable is idempotent, pause keeps the token, regenerate replaces it, a stale
      `rotationCount` raises the conflict.

- [ ] **T9**. Add the board projection service. **Requires AW-02's Focus-layout column
      projection.**
    - Create `packages/agent/src/shared-views/shared-view-projection.service.ts`:
      `projectBoard(organizationId)` reads the **same** column query the private Task
      board uses for its Focus layout (`Backlog`, `In flight`, `Needs you`, `Done`
      grouping the seven `TaskStatus` values), caps each column at 50 rows, projects
      Agents and the last 20 publishable activity rows, and passes everything through
      T5's filters.
    - **Test**: `packages/agent/src/shared-views/__tests__/shared-view-projection.service.spec.ts`
      — column order and membership match the private Focus-layout fixture; cancelled
      Tasks, recurring templates and board-hidden Tasks are absent and are not counted;
      the `+N more` overflow number is correct.

### API — owner side

- [ ] **T10**. Add the owner guard.
    - Create `apps/api/src/shared-views/shared-view-owner.guard.ts`: resolves
      `organizationId → tenantId → tenant.ownerUserId` and throws `NotFoundException`
      (never `ForbiddenException`).
    - **Test**: `apps/api/src/shared-views/shared-view-owner.guard.spec.ts`.

- [ ] **T11**. Add the owner controller.
    - Create `apps/api/src/shared-views/shared-views.controller.ts` and
      `apps/api/src/shared-views/shared-views.module.ts`; register the module in
      `apps/api/src/api.module.ts`.
    - Routes per [`plan.md` §4.1](./plan.md#41-owner-facing--appsapisrcshared-viewsshared-viewscontrollerts):
      `GET /`, `POST /`, `POST /regenerate`, `PATCH /`, `DELETE /`, `GET /preview`,
      `GET /knowledge-classes` (returns zeroes until P3).
    - Class-level guards: `AuthSessionGuard`, `OrganizationOwnershipGuard`; add
      `SharedViewOwnerGuard` on every write and on the token-bearing read.
    - `@Throttle` 10/min on `POST /` and `POST /regenerate`, 30/min on `PATCH /`.
    - Swagger decorators on every route.
    - **Test**: `apps/api/src/shared-views/shared-views.controller.spec.ts` — owner-only
      writes, non-owner member gets settings **without** `link`, non-member `404`,
      throttle metadata present.

- [ ] **T12**. Emit activity rows for every owner-side change.
    - Append `SHARED_VIEW_ENABLED`, `SHARED_VIEW_DISABLED`, `SHARED_VIEW_REGENERATED`,
      `SHARED_VIEW_SECTIONS_CHANGED`, `SHARED_VIEW_INDEXING_CHANGED` to
      `packages/agent/src/entities/activity-log.types.ts` (append only — no reordering; no
      migration needed, the column is a free `varchar(50)`).
    - Write one row per changed facet from `SharedViewService` via
      `packages/agent/src/activity-log/activity-log.service.ts`.
    - **Test**: extend `packages/agent/src/shared-views/__tests__/shared-view.service.spec.ts`
      — asserts one row per facet and that **no** row's payload contains the token.

### API — public side

- [ ] **T13**. Add the public-response header interceptor.
    - Create `apps/api/src/shared-views/shared-view-headers.interceptor.ts` setting
      `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
      `X-Content-Type-Options: nosniff`, and
      `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` unless the resolved Shared
      view has `searchIndexable === true`.
    - **Test**: covered by T14's controller spec.

- [ ] **T14**. Add the public controller.
    - Create `apps/api/src/shared-views/shared-view-public.controller.ts`,
      `@Controller('api/public/shared-view')`, `@Public()` (decorator from
      `apps/api/src/auth/decorators/public.decorator.ts`).
    - `POST /sessions` with body `{ token }` (DTO field named `token`, so
      `SentryInterceptor.SENSITIVE_BODY_KEYS` already drops it) → `{ viewSession, expiresAt }`,
      and `GET /board` authorised by `Authorization: Bearer <viewSession>` through a
      `SharedViewSessionGuard` (T14a). **No route takes the token in its path or query
      string** (spec FR-7a; plan §4.2). Knowledge routes are added in P3 and return `404`
      until then.
    - Two throttle buckets: 60/min keyed on the token hash (the Shared view id for reads),
      600/hour keyed on the client; both evaluated **before** the projection query. `429`
      carries `Retry-After: 60`.
    - Unknown / rotated / paused tokens, and a view session whose link was regenerated or
      paused, must produce a byte-identical response.
    - Drive the view counter and first-view notification from `POST /sessions`, not from
      each read.
    - **Test**: `apps/api/src/shared-views/shared-view-public.controller.spec.ts` —
      identical bodies for every failure cause; every header present; `X-Robots-Tag`
      omitted only when indexable; the `429` shape; an assertion that no read route accepts
      a write verb; and a reflective assertion over the controller's route metadata that no
      path or query parameter carries the token.

- [ ] **T14a**. Add the view-session service and guard.
    - Create `apps/api/src/shared-views/shared-view-session.service.ts` and
      `shared-view-session.guard.ts` per plan §4.2: HMAC-SHA256 compact token with claims
      `{ v, sid, rot, exp }`, 15-minute TTL, secret `SHARED_VIEW_SESSION_SECRET` falling back
      to `BETTER_AUTH_SECRET` / `AUTH_SECRET` (the `TerminalAttachService` posture), fail
      closed with no secret. The guard verifies MAC and expiry with `timingSafeEqual`, then
      requires `status = 'active'` and `rotationCount = rot` on the row.
    - **Test**: `apps/api/src/shared-views/shared-view-session.service.spec.ts` — round trip;
      tampered MAC, expired, stale `rot` and paused view all refused identically; no secret
      refuses everything; the claims contain no token and no token hash.
    - **Done when**: a view session minted before `POST /regenerate` is refused on its next
      request.

- [ ] **T14b**. Redact share tokens in every request recorder.
    - Create `packages/monitoring/src/redaction/secret-url.ts` exporting `redactSecretUrl` and
      `redactSecretValue` (share token after a `/share/` segment, with or without a locale
      prefix; `Bearer` view sessions; body `token` values → `[redacted]`), exported from the
      package index.
    - Modify `apps/api/src/logging.interceptor.ts` to log `redactSecretUrl(originalUrl)` on
      the request, response and error lines.
    - Modify `packages/monitoring/src/interceptors/sentry.interceptor.ts` (context `url`,
      `transaction` and `endpoint` tags), `packages/monitoring/src/sentry/sentry.config.ts`
      (`beforeSend` / `beforeSendTransaction`: `request.url`, transaction name, breadcrumb
      `data.url`) and `packages/monitoring/src/interceptors/posthog.interceptor.ts` (`endpoint`).
    - Route the public controller's thrown errors, and any message or URL logged by an
      `APP_FILTER` filter under `apps/api/src/common/filters/`, through `redactSecretValue`.
    - Modify `apps/web/src/components/posthog/PostHogProvider.tsx`: no `posthog.init` and no
      page-view capture on a share route (spec FR-40), plus a `sanitize_properties` hook
      redacting `$current_url`, `$pathname` and `$referrer`.
    - **Test**: `packages/monitoring/src/redaction/__tests__/secret-url.spec.ts` (new); extend
      `apps/api/src/logging.interceptor.spec.ts`,
      `packages/monitoring/src/interceptors/__tests__/sentry.interceptor.spec.ts`,
      `posthog.interceptor.spec.ts` and `packages/monitoring/src/sentry/__tests__/sentry.config.spec.ts`;
      a web unit spec that the provider does not initialise on `/share/<token>` or
      `/<locale>/share/<token>`.
    - **Done when**: the specs pass, and the edge access-log format for the web host has been
      confirmed to drop or redact `/share/` paths (recorded in the PR description).

- [ ] **T14c**. Prove the token never reaches a log line.
    - Create `apps/api/test/shared-view-log-hygiene.e2e-spec.ts`: boot the API with the real
      `LoggingInterceptor`, `SentryInterceptor` and `PostHogInterceptor`, a capturing Nest
      `Logger`, and spies on `Sentry.captureException` / `setContext` / `setTag` /
      `addBreadcrumb` and PostHog `trackEvent`. Run an exchange, a board read, an
      unknown-token exchange, a read after regenerate, a throttled read and a forced `500`
      with `config.debug()` on.
    - Assert that neither the raw token nor the view session occurs as a substring in any
      captured log line, Sentry payload or PostHog property.
    - Create `apps/web/e2e/shared-view-token-transport.spec.ts`: record every request the
      published page issues over three poll cycles in a fresh context; assert no request URL
      contains the token, no analytics request is issued, and the token appears only in
      `POST /sessions` bodies.
    - **Done when**: both specs are green and part of the P1 gate.

### Background work

- [ ] **T15**. Add the view-counter buffer and flush task.
    - Add `SHARED_VIEW_COUNTER_FLUSH_DISPATCHER` to
      `packages/agent/src/tasks/_tasks-symbols.ts` (alphabetical) and create
      `packages/agent/src/tasks/shared-view-counter-flush-dispatcher.ts` and its
      sibling `shared-view-counter-flush.types.ts` (the token + payload convention every
      other dispatcher in that folder follows).
    - Create `packages/tasks/src/tasks/trigger/shared-view-counter-flush.task.ts` (cron
      every 5 minutes) and export it from
      `packages/tasks/src/tasks/trigger/index.ts`.
    - Buffer key: salted, truncated client hash + token hash, 10-minute dedupe window,
      24 h TTL, **never persisted** and never containing a raw IP.
    - Bind through `buildJobRuntimeProviders()` in
      `packages/tasks/src/trigger/trigger.module.ts` — the call site depends on the symbol
      only (Constitution IV).
    - **Test**: `packages/tasks/src/__tests__/shared-view-counter-flush.task.spec.ts`
      — dedupe window, idempotent flush, no raw IP anywhere in the buffer payload.
    - **Done when**: `packages/agent/src/tasks/tasks.spec.ts` (which pins the exported
      runtime-symbol set) is green.

- [ ] **T16**. Add the first-view notification.
    - Add `notifySharedViewFirstView()` to
      `packages/agent/src/notifications/notification.service.ts` with event key
      `shared_view_first_view`.
    - **Register the key in `CORE_EVENTS`** in
      `apps/api/src/notifications/notification-event-type-bootstrap.service.ts` with
      `defaultChannels: ['in-app']` — an unregistered key can never fan out to a channel
      and never appears in the preference matrix.
    - Fire from the flush task when `firstViewNotifiedAt IS NULL`, then set it.
    - **Test**: `packages/agent/src/notifications/notification.service.spec.ts`
      (extend) — fires once, never twice; and a bootstrap spec asserting the key is
      registered.

### Web

- [ ] **T17**. Add the routes and make the share route public.
    - In `apps/web/src/lib/constants.ts`: add
      `DASHBOARD_SETTINGS_SHARING: '/settings/sharing'`, `SHARE_VIEW: '/share/:token'`
      and a `shareView(token)` href helper; add `ROUTES.SHARE_VIEW` to `PUBLIC_ROUTES`
      **in the same commit**.
    - **Test**: extend `apps/web/src/lib/__tests__/public-routes.unit.spec.ts` to pin
      `/share/<token>` as public.
    - **Done when**: the spec is green. Omitting the `PUBLIC_ROUTES` entry makes
      `apps/web/src/proxy.ts` bounce the visitor **and clear the session cookie** — this
      task exists to stop that shipping.

- [ ] **T18**. Build the published page.
    - Create `apps/web/src/app/[locale]/share/[token]/page.tsx` (server component; first
      paint requires no client JS; exchanges the token via `POST /sessions` in a request body
      and passes only `{ viewSession, expiresAt }` to client components — plan §4.4),
      `apps/web/src/app/[locale]/share/[token]/not-active.tsx`,
      `apps/web/src/components/share/PublishedShell.tsx`,
      `apps/web/src/components/share/PublishedBoard.tsx`.
    - Implement all states from `spec.md` §6.7: loading skeleton, empty board, not
      active, throttled, poll-paused, preview banner, and the ≥360 px single-column
      layout with sticky column headers.
    - Poll every 20 s with `Authorization: Bearer <viewSession>`; never build an API URL from
      the token. Re-exchange (token in a body) when `expiresAt` is under 60 s away or a read
      returns the not-active response; a failed re-exchange renders not-active. Pause on
      `document.hidden`; stop after 30 min idle with a **Resume** control; back off to 60 s
      on `429`; keep the last good render on a network error.
    - Keyboard map and polite live region per `spec.md` §6.12.
    - **Test**: `apps/web/src/components/share/__tests__/PublishedBoard.unit.spec.tsx`
      for the poll state machine.

- [ ] **T19**. Apply the per-view crawler directive where it can actually vary.
    - `/robots.txt` is a single site-wide file with no knowledge of which `/share/[token]` a
      crawler will fetch, so it cannot express a per-view choice. Do **not** make it depend on
      `searchIndexable`.
    - The per-view directive is carried by the resolved response itself: the page and the public
      API send `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and render
      `<meta name="robots" content="noindex, nofollow">` **unless** the resolved view has
      `searchIndexable === true` (T14/T18 already emit the header; this task owns the page meta and
      the tests).
    - If a site-wide `robots.ts` is added for other reasons, it stays independent of Shared views and
      must not `Disallow: /share/`, because a disallowed URL is never fetched and so its
      `noindex` header is never seen.
    - **Done when**: a blocked view returns the header and meta; an indexable view returns
      neither; and `/robots.txt` is byte-identical whatever any Shared view's setting is.

- [ ] **T20**. Build Settings → Sharing.
    - Create `apps/web/src/app/[locale]/(dashboard)/settings/sharing/page.tsx`,
      `apps/web/src/components/settings/SharingSettings.tsx`, and
      `apps/web/src/app/actions/shared-view.ts` (`getSharedView`, `createSharedView`,
      `regenerateSharedViewLink`, `updateSharedView`, `deleteSharedView`,
      `getKnowledgeClassCounts`).
    - Add the `Sharing` entry after `Organization` in
      `apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx`.
    - Render all states from `spec.md` §6.2–§6.4, including the non-owner read-only state
      and all three confirmation dialogs with their exact copy.
    - The Knowledge toggle renders disabled with the existing "coming soon" treatment
      until P3.
    - **Test**: `apps/web/src/components/settings/SharingSettings.unit.spec.tsx` —
      non-owner never receives the link in props; every destructive action is behind a
      confirmation.

- [ ] **T21**. Add the P1 i18n keys.
    - Add the `dashboard.sharing` and top-level `share` namespaces to
      `apps/web/messages/en.json` exactly as listed in
      [`plan.md` §8.1 and §8.3](./plan.md#8-i18n), plus
      `notifications-v2.sharedViewFirstViewTitle` / `…Body`.
    - Mirror the same **key set** into all 20 sibling locale files in
      `apps/web/messages/`.
    - **Done when**: no leaf key contains a literal `.`, every leaf is camelCase, the key
      sets match across all 21 files, and the hydration e2e shard is green.

- [ ] **T22**. P1 end-to-end coverage.
    - Create `apps/api/test/shared-view.e2e-spec.ts` — publish → read → regenerate →
      old-token-dead against a real HTTP stack.
    - Create `apps/web/e2e/shared-view-publish.spec.ts`,
      `apps/web/e2e/shared-view-public-page.spec.ts`,
      `apps/web/e2e/shared-view-revoke.spec.ts`,
      `apps/web/e2e/shared-view-noindex.spec.ts`,
      `apps/web/e2e/shared-view-a11y.spec.ts`.
    - Every spec that opens `/share/:token` **must** use a browser context with no storage
      state, or it proves nothing about anonymous access.
    - **Done when**: all five pass locally and in CI, and the revoke spec observes the
      "no longer active" swap within 20 s in a second context.

---

## Phase 2 — Participate (P2)

Ships FR-50…FR-79.

### Data model

- [ ] **T23**. Add the `ChannelGuest` entity.
    - Create `packages/agent/src/entities/channel-guest.entity.ts` with the columns in
      [`plan.md` §3.2](./plan.md#32-new-entity--channelguest), keyed on `bindingId`
      (FK → `ingest_install_bindings`, `ON DELETE CASCADE`).
    - Export from `packages/agent/src/entities/index.ts`; register in
      `packages/agent/src/database/_entities-inventory.ts` and `_entity-names.ts`.
    - Indexes: `UNIQUE(bindingId, externalUserId)`, `INDEX(ownerUserId, status)`,
      `INDEX(bindingId, externalUserId, status)`.
    - **Test**: `packages/agent/src/entities/__tests__/channel-guest.entity.spec.ts`.

- [ ] **T24**. Write the `channel_guests` migration.
    - Create `apps/api/src/migrations/1791180100000-CreateChannelGuests.ts`.
    - **Done when**: additive only; `down()` drops just the table and its indexes.

- [ ] **T25**. Write the attribution-columns migration. - Create `apps/api/src/migrations/1791180200000-AddRequesterAttribution.ts` adding
      `requestedByGuestId` (FK → `channel_guests`, `ON DELETE SET NULL`) and
      `requestedByLabel varchar(160)` to `tasks`, `missions`,
      `agent_action_proposals`, `agent_escalations`, plus `originConversationRef
varchar(256)` to `agent_action_proposals` and `agent_escalations`. - `tasks` is the primary case (a guest's request produces Tasks); `missions` carries
      the same pair only for the case where the Run sets up a standing initiative at the
      guest's request (FR-68). - Add the matching nullable columns to
      `packages/agent/src/entities/task.entity.ts`,
      `packages/agent/src/entities/mission.entity.ts`,
      `packages/agent/src/entities/agent-action-proposal.entity.ts`,
      `packages/agent/src/entities/agent-escalation.entity.ts` **in the same PR**. - **Done when**: every column is nullable, no existing column is touched, and the
      existing specs for all four entities still pass.

### The gate

- [ ] **T26**. Add the `ChannelGuest` repository.
    - Create `packages/agent/src/database/repositories/channel-guest.repository.ts`:
      `findActiveForBindingAndExternalUser` (the gate's single indexed read),
      `listForBinding`, `countForBinding`, `countForOwner`, `create`, `update`,
      `recordRequest` (bumps `lastSeenAt` + `requestCount`).
    - **Test**: `packages/agent/src/database/repositories/__tests__/channel-guest.repository.spec.ts`.

- [ ] **T27**. Add the guest text fence.
    - Create `packages/agent/src/channel-guests/guest-text-fence.ts`, reusing the fencing
      posture already established in
      `packages/agent/src/services/memory-recall.ts` (fence wrapper, forged-marker break,
      control-marker strip) rather than inventing a third mechanism.
    - Truncate at 4,000 characters with a visible marker (FR-64).
    - **Test**: `packages/agent/src/channel-guests/__tests__/guest-text-fence.spec.ts` —
      forged boundary markers are neutralised; control markers are stripped; truncation
      is marked.

- [ ] **T28**. Add the admission gate.
    - Create `packages/agent/src/channel-guests/channel-guest-admission.service.ts`
      implementing the `ConnectorPairingAuthorizer` signature and returning
      `ConnectorAuthorizationDecision` from
      `packages/plugin/src/contracts/capabilities/connector.interface.ts`.
    - Order: signature verified → binding resolves the owner → sender is the owner
      (admit) → sender is an `active` guest of that binding (admit) → deny.
    - Rate buckets: 30 messages/hour per guest, 300/day per Workspace, one refusal per
      unknown sender per 24 h, one throttle notice per guest per hour.
    - Append `CHANNEL_GUEST_ADMITTED`, `CHANNEL_GUEST_DENIED`, `CHANNEL_GUEST_THROTTLED`
      to `packages/agent/src/entities/activity-log.types.ts` and write one row per
      outcome — **never** the message body.
    - **Test**: `packages/agent/src/channel-guests/__tests__/channel-guest-admission.service.spec.ts`
      — gate order; owner always admitted and never counted against caps; revoked denied;
      the 24 h single-refusal ceiling; and an assertion that **zero facade calls** occur
      on a denial.

- [ ] **T29**. Insert the gate into the inbound path.
    - Modify `apps/api/src/ingest/slack/slack-chat-bridge.service.ts` to call
      `ChannelGuestAdmissionService.authorize()` **after** signature verification and
      binding resolution and **before** any call into
      `apps/api/src/ai-conversation/openai-compat.service.ts`.
    - On a denial, post the refusal (or nothing, inside the 24 h window) through the
      existing reply path and return without dispatching.
    - **Test**: extend `apps/api/src/ingest/slack/slack-chat-bridge.service.spec.ts` —
      denial short-circuits before the completion service; admission passes the fenced
      attribution preamble through.

### Attribution and decision routing

- [ ] **T30**. Add the requester-attribution service.
    - Create `packages/agent/src/channel-guests/requester-attribution.service.ts`:
      builds `"{displayName} · {channelName}"`, stamps `requestedByGuestId` +
      `requestedByLabel` on the Tasks, Approvals and Escalations a guest-originated Run
      creates — and on a Mission only when that Run sets up a standing initiative at the
      guest's request — and appends `(revoked)` when rendering a revoked guest's
      historical label.
    - **Test**: `packages/agent/src/channel-guests/__tests__/requester-attribution.service.spec.ts`
      — label format; stamping on all four record kinds; owner-originated work carries
      **no** label; a revoked guest's historical label is unchanged in the database.

- [ ] **T31**. Route guest-originated decisions to the owner only.
    - Modify the Approval and Escalation creation paths in
      `packages/agent/src/agent-approvals/` and the escalation service under
      `packages/agent/src/` so that a guest-originated Run's decision is always addressed
      to the Tenant owner and carries `originConversationRef`.
    - Emit the fixed decision-pending reply into the originating conversation exactly
      once.
    - **Test**: extend the approvals and escalations service specs — a guest-originated
      decision is never addressed to the guest; a guest message can never satisfy or
      dismiss a pending decision.

- [ ] **T32**. Add the decision-outcome post-back task.
    - Add `DECISION_OUTCOME_POSTBACK_DISPATCHER` to
      `packages/agent/src/tasks/_tasks-symbols.ts` (alphabetical) and create
      `packages/agent/src/tasks/decision-outcome-postback-dispatcher.ts` plus its sibling
      `packages/agent/src/tasks/decision-outcome-postback.types.ts` — the token + payload
      convention every other dispatcher in that folder follows.
    - Create `packages/tasks/src/tasks/trigger/decision-outcome-postback.task.ts`,
      exported from `packages/tasks/src/tasks/trigger/index.ts`; retries
      30 s → 2 m → 8 m, max 4 attempts.
    - Enqueue on approve/reject/resolve when `originConversationRef` is present; suppress
      the post when the guest has been revoked; on final failure, record the failure so
      the settled item shows "Couldn't reply in {channel}".
    - **Test**: `packages/tasks/src/__tests__/decision-outcome-postback.task.spec.ts`
        - the runtime-symbol pin in `packages/agent/src/tasks/tasks.spec.ts`.

### API and web

- [ ] **T33**. Add the guests controller.
    - Create `apps/api/src/channel-guests/channel-guests.controller.ts`,
      `channel-guests.module.ts` and `connection-owner.guard.ts`; register the module in
      `apps/api/src/api.module.ts`.
    - Routes per [`plan.md` §4.3](./plan.md#43-channel-guests--appsapisrcchannel-guestschannel-guestscontrollerts):
      `GET /`, `POST /`, `PATCH /:guestId`, `DELETE /:guestId`, throttled 20/min and
      30/min respectively.
    - `GET /` returns `{ bindingReady: false }` when no signature-verified binding exists
      yet — an owner-typed external workspace id is **never** accepted as proof of
      ownership.
    - Append `CHANNEL_GUEST_ADDED`, `CHANNEL_GUEST_RENAMED`, `CHANNEL_GUEST_REVOKED` to
      `activity-log.types.ts` and write one row per change.
    - **Test**: `apps/api/src/channel-guests/channel-guests.controller.spec.ts` — CRUD,
      the not-ready shape, `409` duplicate, `422` over the 25/100 caps, non-owner `404`.

- [ ] **T34**. Build the allowlist panel.
    - Create `apps/web/src/components/settings/ChannelGuestsPanel.tsx` and
      `apps/web/src/app/actions/channel-guests.ts`.
    - Mount the panel per channel inside
      `apps/web/src/components/settings/NotificationChannelsSettings.tsx`.
    - Render all states from `spec.md` §6.8: populated list, not-ready, full, and the
      revoke confirmation. The service name in the helper copy comes from the plugin
      manifest via the registry — **no** switch over plugin ids in `apps/web`.
    - **Test**: `apps/web/src/components/settings/ChannelGuestsPanel.unit.spec.tsx`.

- [ ] **T35**. Surface the requester label.
    - Add the optional label line to the Task card and Task detail header (AW-02
      components), to the Mission detail header, and to the My Decisions row (AW-03
      component).
    - Render nothing when the label is absent — the absence of a label means "the owner
      asked", and the UI must not invent one.
    - Confirm the label is **not** present in any `Published*` DTO (T5's key-set spec
      already enforces this).
    - **Test**: extend the relevant component unit specs.

- [ ] **T36**. Add the P2 i18n keys.
    - Add `dashboard.channelGuests` to `apps/web/messages/en.json` per
      [`plan.md` §8.2](./plan.md#82-dashboardchannelguests-the-allowlist-panel), plus
      `notifications-v2.channelGuestDeniedTitle` / `…Body`.
    - Add the six agent-facing channel replies from `spec.md` §6.10 under
      `api.channelGuest` in the API's message catalogue, resolved in the **owner's**
      locale with `{ownerName}`, `{note}` and `{channel}` interpolations.
    - Register `channel_guest_denied` in `CORE_EVENTS` in
      `apps/api/src/notifications/notification-event-type-bootstrap.service.ts`.
    - Mirror the key set into all 20 sibling locale files.
    - **Done when**: no leaf key contains a literal `.`, key sets match across all 21
      files, and the hydration shard is green.

- [ ] **T37**. P2 end-to-end coverage.
    - Create `apps/web/e2e/channel-guests.spec.ts` — add, rename, revoke, caps, the
      not-ready state, and a non-owner seeing nothing.
    - Extend `apps/api/test/shared-view.e2e-spec.ts` (or add
      `apps/api/test/channel-guests.e2e-spec.ts`) with the gate paths: denied sender
      starts no run; the 24 h refusal ceiling; the hourly cap.
    - **Done when**: both pass in CI.

- [ ] **T38**. Update the program vocabulary table.
    - Add **Shared view** and **Channel guest** to the vocabulary table in
      `docs/specs/features/agent-workspace/README.md` §1, and mark AW-18 in
      `docs/specs/features/agent-workspace/TRACKER.md`.
    - **Done when**: both nouns appear with their "do not introduce" synonym bans, as
      program rule #2 requires.

---

## Phase 3 — Refine (P3)

Ships FR-25…FR-33 and the deferred half of FR-28.

- [ ] **T39**. Add the knowledge publish predicate.
    - Create `packages/agent/src/shared-views/knowledge-publish-predicate.ts`: a document
      is published only if its `kbDocumentClass` is in `SharedView.knowledgeClasses`, its
      `status === 'active'`, its `reviewState` is not `'proposed'`, and it is not
      excluded.
    - **Test**: `packages/agent/src/shared-views/__tests__/knowledge-publish-predicate.spec.ts`
      — an empty class list yields zero documents (fails closed, never "everything").

- [ ] **T40**. Add the per-document exclusion flag.
    - Add `sharedViewExcluded: boolean` (default `false`) to
      `packages/agent/src/entities/work-knowledge-document.entity.ts` and ship
      `apps/api/src/migrations/1791180300000-AddKbSharedViewExcluded.ts` in the same PR.
    - **Done when**: the column is `NOT NULL DEFAULT false`, `down()` drops only it, and
      existing KB specs still pass.

- [ ] **T41**. Extend the projection and public API for knowledge.
    - Add `projectKnowledgeList` and `projectKnowledgeDocument` to
      `packages/agent/src/shared-views/shared-view-projection.service.ts`.
    - Add `GET /knowledge` and `GET /knowledge/:docId` to
      `apps/api/src/shared-views/shared-view-public.controller.ts`, both behind
      `SharedViewSessionGuard` (T14a) — the token is never in the path — `q` min 2
      characters, 50 per page, 200 total, 200 distinct documents per hour per Shared view.
      Extend `apps/api/test/shared-view-log-hygiene.e2e-spec.ts` (T14c) with a knowledge list,
      a search and a document read.
    - **Test**: extend `apps/api/src/shared-views/shared-view-public.controller.spec.ts`
      — a deselected class 404s on the next request; git history, citations, retrieval
      trail, uploads and originals are never in the response.

- [ ] **T42**. Build the knowledge reader.
    - Create `apps/web/src/components/share/PublishedKnowledge.tsx` (two-pane list +
      reader, 300 ms debounced search) and wire the tab in
      `apps/web/src/components/share/PublishedShell.tsx`.
    - Implement the empty state and the "no longer published" state from `spec.md` §6.7.

- [ ] **T43**. Enable the Knowledge section in Settings → Sharing.
    - Un-disable the toggle in
      `apps/web/src/components/settings/SharingSettings.tsx`; add the class picker with
      live per-class counts from `GET /knowledge-classes`; implement the confirm dialog
      that states the exact number of documents that will become public.
    - Add the per-document "Exclude from shared view" control to the KB document metadata
      panel.
    - **Test**: extend `SharingSettings.unit.spec.tsx` — enabling with no classes selected
      is blocked at the UI and serves nothing at the API.

- [ ] **T44**. Add the guest activity report.
    - Add a "Requests from guests, last 30 days" block to
      `apps/web/src/components/settings/SharingSettings.tsx`, sourced from the
      `channel_guest_*` activity rows.
    - **Test**: unit spec on the aggregation.

- [ ] **T45**. Add the P3 i18n keys and e2e.
    - Extend `dashboard.sharing` and `share` with the class-picker, reader and
      exclusion-control strings; mirror into the 20 sibling locale files.
    - Create `apps/web/e2e/shared-view-knowledge.spec.ts` — publish one class, read a
      document anonymously, deselect the class, confirm the document 404s.

- [ ] **T46**. Close the open questions.
    - Take `spec.md` §9 to review; land decisions for link expiry, link scope,
      guest-identifier ergonomics (pairing codes), co-owned workspaces, the activity
      strip's titles, and per-document exclusion.
    - **Done when**: every `[NEEDS CLARIFICATION: …]` marker in `spec.md` is either
      resolved in place or converted into a follow-up epic reference.
