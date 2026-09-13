# AW-13 — Notification matrix & attention budget · Task breakdown

> Ordered work derived from [plan.md](./plan.md), behaviour from [spec.md](./spec.md).
> Every task carries explicit paths and a definition of "done". Execute top to bottom.

**Epic ID:** `AW-13-attention-controls`
**Spec:** [./spec.md](./spec.md) · **Plan:** [./plan.md](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-09-06

---

## How to use

- Tasks are sequential unless marked `(parallel)`, which means they may land alongside the task
  immediately above them.
- `P1` / `P2` / `P3` mark the phase. Each phase is independently shippable and must leave
  `develop` green on its own.
- Every schema change ships its migration **in the same PR** (Constitution V). The migration task
  is never a follow-up.
- Formatting: tabs, width 4, 120 columns, single quotes, semicolons, no trailing commas (the root
  Prettier config wins). Files are kebab-case; React components are PascalCase files.
- Do not use conditional spreads (`...cond && { k: v }`) in anything that emits declarations —
  it breaks DTS in this repo.
- Run `pnpm format && pnpm lint && pnpm type-check` before every PR.

---

## Phase P1 — the matrix works

### Contracts

- [ ] **T1 · P1.** Shared notification contracts.
    - Create `packages/contracts/src/notifications/attention.types.ts` —
      `AttentionTargetClass = 'email' | 'channel'`,
      `ATTENTION_TARGET_CLASSES: readonly AttentionTargetClass[]`,
      `AttentionBudgetSnapshot { targetClass; used; limit; held; resetsAt; enabled }`.
    - Create `packages/contracts/src/notifications/notification-matrix.dto.ts` with
      `MatrixGroup`, `MatrixColumnDto`, `MatrixEventDto`, `NotificationMatrixDto` — shapes in
      [plan §3.4](./plan.md#34-contracts).
    - Create `packages/contracts/src/notifications/index.ts`; add
      `export * from './notifications/index.js';` to `packages/contracts/src/index.ts`.
    - **Done**: `pnpm --filter @ever-works/contracts build` emits declarations with no DTS error;
      `import type { NotificationMatrixDto } from '@ever-works/contracts'` resolves from both
      `apps/api` and `apps/web`.

### The event catalogue

- [ ] **T2 · P1.** Move the core event catalogue into the agent package and complete it.
    - Create `packages/agent/src/notifications/core-event-catalogue.ts` exporting
      `CoreNotificationEvent` and `CORE_NOTIFICATION_EVENTS: readonly CoreNotificationEvent[]`
      with **23** rows — the 15 that
      `apps/api/src/notifications/notification-event-type-bootstrap.service.ts` holds today, plus
      the 8 new keys, with the categories, `urgent` flags and `defaultChannels` from
      [spec §4.5 FR-26](./spec.md#45-the-event-catalogue-and-its-defaults).
    - New keys: `credits_balance_exhausted`, `payg_cap_80`, `payg_cap_100`, `payg_past_due`,
      `budget_threshold_warning`, `budget_threshold_reached`, `memory_consolidation_ready`,
      `digest_ready`.
    - Corrections: `git_auth_expired` category `integrations` → `security`;
      `agent_run_finished` category `agents` → `agent`; `urgent` becomes `true` for
      `agent_run_escalated`, `inbox_approval_requested`, `inbox_escalation`, `mission_blocked`.
    - Export it from `packages/agent/src/notifications/index.ts`.
    - **Done**: every `category` value is a member of `NotificationCategory` in
      `packages/agent/src/entities/notification.types.ts`; the file contains no delivery logic,
      only data.

- [ ] **T3 · P1.** Point the bootstrap at the shared catalogue.
    - `apps/api/src/notifications/notification-event-type-bootstrap.service.ts` — delete the local
      `CORE_EVENTS` array and the `CoreEventRow` interface, import
      `CORE_NOTIFICATION_EVENTS` from `@ever-works/agent/notifications`, and keep the upsert loop,
      the plugin-manifest pass and the defensive `readManifestEvents` reader exactly as they are.
    - **Done**: the service's behaviour is byte-identical for the 15 pre-existing keys and adds
      the 8 new ones; `apps/api` boots on SQLite with 23 core rows in `notification_event_types`.

- [ ] **T4 · P1.** The regression guard that stops this defect recurring.
    - Create `packages/agent/src/notifications/__tests__/event-registry-coverage.spec.ts`.
    - Read `packages/agent/src/notifications/notification.service.ts` as text, extract every
      string literal passed as `eventKey:`, and assert each one has a row in
      `CORE_NOTIFICATION_EVENTS`. Handle the two interpolated forms explicitly: the pay-as-you-go
      key is `payg_cap_${percent}` where `percent` is typed `80 | 100`, and the inbox key comes
      from the `eventKeyByKind` map — assert all six resulting literals.
    - Assert every catalogue `category` is a `NotificationCategory` member (so it is a valid mute
      target) and that no two rows share a `key`.
    - **Done**: the spec fails if a producer gains an `eventKey` with no catalogue row, and fails
      if a catalogue row uses a category that `POST /api/notifications/preferences/mute` would
      reject.

- [ ] **T5 · P1.** Give the budget alert an event identity.
    - `packages/agent/src/notifications/notification.service.ts` —
      `notifyBudgetThresholdCrossed` gains a `dispatchFanout` call after `create()`, with
      `eventKey: 'budget_threshold_reached'` when `threshold` is `'100'` or `'overage'`, else
      `'budget_threshold_warning'`; `urgent` mirrors the same condition.
    - **Done**: the producer is the only place the threshold-to-key mapping exists;
      `notification.service.spec.ts` covers all four threshold values.

### Email as a built-in delivery target

- [ ] **T6 · P1.** The sender port.
    - Create `packages/agent/src/notifications/notification-email-sender.port.ts` —
      `NOTIFICATION_EMAIL_SENDER = Symbol.for('NOTIFICATION_EMAIL_SENDER')`,
      `NotificationEmailInput { userId; eventKey?; title; message; actionUrl?; actionLabel? }`,
      `NotificationEmailResult { status: 'delivered' | 'failed' | 'not-configured';
      providerMessageId?; error? }`, `NotificationEmailSender { deliver(input): Promise<...> }`.
    - Export from `packages/agent/src/notifications/index.ts`.
    - **Done**: the port has no import from `apps/api` and no mail-library import.

- [ ] **T7 · P1.** Entity changes for silent records and built-in delivery targets.
    - `packages/agent/src/entities/notification.entity.ts` — add
      `@Column({ default: false }) isSilent: boolean;` and
      `@Index('idx_notifications_user_silent_read', ['userId', 'isSilent', 'isRead'])`.
    - `packages/agent/src/entities/notification-channel-delivery-log.entity.ts` — make
      `channelId` `{ type: 'uuid', nullable: true }` and `string | null`; make the `@ManyToOne`
      relation optional; add `@Column({ type: 'varchar', length: 16, nullable: true })
      builtInChannel?: string | null;` and `@Column({ type: 'uuid', nullable: true }) userId?:
      string | null;` (**no** `@ManyToOne` on `userId` — follow the Tier-C comment already on
      `tenantId`); add `@Index('idx_ncdl_user_created', ['userId', 'createdAt'])`.
    - `packages/agent/src/entities/notification.types.ts` — add optional `eventKey?: string` to
      `CreateNotificationDto` and optional `includeSilent?: boolean` to
      `NotificationQueryOptions`.
    - **Done**: `pnpm --filter @ever-works/agent type-check` is green and every existing
      `NotificationService.create()` call site compiles untouched.

- [ ] **T8 · P1.** Ship the migration for T7 and the registry data, in the same PR.
    - From `apps/api/`: `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AttentionMatrixFoundations`,
      then rename the emitted file to
      `apps/api/src/migrations/1791130000000-AttentionMatrixFoundations.ts`.
    - Hand-edit `up()` so it contains **only**:
      `ALTER TABLE "notifications" ADD COLUMN "isSilent" boolean NOT NULL DEFAULT false`;
      `ALTER TABLE "notification_channel_delivery_log" ALTER COLUMN "channelId" DROP NOT NULL`;
      `ADD COLUMN "builtInChannel" varchar(16)`; `ADD COLUMN "userId" uuid`;
      two `CREATE INDEX CONCURRENTLY` statements
      (`idx_notifications_user_silent_read`, `idx_ncdl_user_created`);
      the 23 `INSERT INTO "notification_event_types" … ON CONFLICT ("key") DO UPDATE SET
      "category" = EXCLUDED."category", "title" = …, "description" = …, "urgent" = …,
      "defaultChannels" = …` rows (guarded to `source = 'core'`);
      and the opt-out backfill —
      `INSERT INTO "user_notification_subscriptions" ("userId","eventTypeKey","channelIds")
       SELECT id, 'budget_threshold_warning', '["in-app"]' FROM "users"
       WHERE "emailBudgetAlerts" = false ON CONFLICT DO NOTHING` and the same for
      `budget_threshold_reached`.
    - `down()` drops the two columns, the index, restores `NOT NULL` only if no NULL rows exist,
      and deletes the 8 inserted keys. It does **not** attempt to un-correct the 2 categories or
      the 4 urgency flags.
    - Remove the migration's implicit transaction if the driver requires it for
      `CREATE INDEX CONCURRENTLY`.
    - **Done**: no `DROP COLUMN` on a pre-existing column, no `NOT NULL` added to a populated
      column, no `UPDATE` against `users`; running the migration twice against a seeded local DB
      leaves exactly 23 core rows in `notification_event_types`.

- [ ] **T9 · P1.** The email sentinel in the channel facade.
    - `packages/agent/src/facades/notification-channel.facade.ts` — in `sendOne`, immediately
      after the existing `if (channelId === 'in-app')` branch, add
      `if (channelId === 'email')`: require `options.userId` (same IDOR posture as
      `sendDirect`/`deliverToChannelOrThrow`), call the optionally-injected
      `NOTIFICATION_EMAIL_SENDER` port, write a `notification_channel_delivery_log` row with
      `channelId: null`, `builtInChannel: 'email'`, `userId: options.userId`, and return
      `{ channelId: 'email', pluginId: 'email', status }`. A missing port returns
      `status: 'failed', error: 'email sender not configured'` — never a silent success.
    - In the same file, stamp `userId: options.userId ?? channel.userId` on **every**
      delivery-log write, including the existing plugin path.
    - Do not change `dispatchOrSend` — `'email'` is already `!== 'in-app'`, so it routes through
      the existing `NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER` and inherits retry, the
      quiet-hours `delay`, and the in-process fallback.
    - **Done**: `'email'` never reaches `NotificationChannelRepository`;
      `deliverToChannelOrThrow('email', …)` throws on a failed send so
      `packages/tasks/src/tasks/trigger/notification-channel-delivery.task.ts` retries it
      unchanged.

- [ ] **T10 · P1.** The API-side sender and its template.
    - Create `apps/api/src/templates/notification.hbs` — title, message, one primary action
      button, the "You get this because **{{eventTitle}}** is on for Email." line, and a link to
      the matrix. Match the visual language of `apps/api/src/templates/budget-alert.hbs`.
    - `apps/api/src/mail/templates.ts` — add `'notification'` to `KNOWN_EMAIL_TEMPLATES` (the
      packaging spec asserts the list and the directory agree in both directions, so this is
      required, not optional).
    - `apps/api/src/mail/mail.service.ts` — add `sendNotificationEmail(toEmail, recipientName,
      context)` following the shape of `sendBudgetAlertEmail`, including its `requireEmail` guard.
    - Create `apps/api/src/notifications/notification-email-sender.service.ts` implementing
      `NotificationEmailSender`: resolve the user through `UserRepository`, skip with
      `not-configured` when the mail transport is unavailable, skip with `failed` +
      `'address-unverified'` when `emailVerified` is false, otherwise send. Never log the address
      above `debug`.
    - `apps/api/src/notifications/notifications.module.ts` — import `MailModule` (it exports
      `MailService` and imports nothing from this tree, so there is no cycle), and bind
      `{ provide: NOTIFICATION_EMAIL_SENDER, useExisting: NotificationEmailSenderService }`.
    - **Done**: a real notification with `email` in its plan produces a MailHog message locally;
      `pnpm --filter ever-works-api test -- templates.spec` is green.

### Routing correctness

- [ ] **T11 · P1.** Accept `email` as a built-in target and make "nothing" mean nothing.
    - `apps/api/src/notifications/notification-preferences.service.ts` — add `'email'` to
      `BUILT_IN_CHANNEL_IDS`. Leave `MAX_SUBSCRIPTION_CHANNELS = 20` and the per-id ownership
      loop untouched.
    - `packages/agent/src/notifications/user-notification-subscription.service.ts` — in
      `loadInitialChannels`, change the subscription branch from
      `if (sub?.channelIds && sub.channelIds.length > 0)` to `if (sub)` and return
      `[...sub.channelIds]` — an existing row wins even when empty (spec FR-13). Add a comment
      naming the scenario so nobody "fixes" it back.
    - In `resolvePlan`, when `findByKey` misses, increment an
      `notifications.eventKey.unregistered` analytics counter (best-effort, never throws) before
      returning the in-app fallback.
    - **Done**: `user-notification-subscription.service.spec.ts` proves an empty stored array
      resolves to `{ immediate: [], deferred: [] }`, and that a stored `['email']` survives the
      whole chain.

- [ ] **T12 · P1.** Silent in-app records.
    - `packages/agent/src/notifications/notification.service.ts` — optionally inject
      `UserNotificationSubscriptionService`. In `create()`, when `dto.eventKey` is present, the
      resolver is wired, and `dto.isPersistent` is not true, set
      `isSilent = !plan.immediate.includes('in-app')`. Wrap the resolution in try/catch and
      default to `false` (loud) on any error — spec FR-49.
    - Pass `eventKey` from all 16 producers, using the same literal each already passes to
      `dispatchFanout` (and, for `notifyInboxItem`, the same `eventKeyByKind` lookup).
    - `packages/agent/src/database/repositories/notification.repository.ts` — add
      `isSilent: false` to the unread-count predicate and to the default list predicate; honour
      `options.includeSilent` to lift it.
    - `apps/api/src/notifications/notifications.controller.ts` — add an optional
      `includeSilent` boolean query param to `GET /` (default `false`). `GET /unread-count`
      **never** includes silent rows.
    - **Done**: a notification for an event with in-app off is written, is absent from
      `/unread-count`, and is returned by `GET /?includeSilent=true`; a persistent notification is
      never silent.

- [ ] **T13 · P1.** Move budget-alert email onto the matrix.
    - `apps/api/src/budgets/budget-alert.handler.ts` — remove the direct
      `mailService.sendBudgetAlertEmail(...)` call and the `user.emailBudgetAlerts` gate from the
      handler; the in-app write and the analytics track stay exactly as they are. The email now
      arrives via the fan-out T5 introduced.
    - `packages/agent/src/entities/user.entity.ts` — add an `@deprecated` doc comment to
      `emailBudgetAlerts` stating it is retained for account export/import and was folded into the
      matrix by AW-13. **Do not remove the column.**
    - Decide the template question from [spec §9](./spec.md#9-open-questions) before starting: if
      Product keeps the rich `budget-alert.hbs` layout, add a first-party
      `eventKey → template` map inside `notification-email-sender.service.ts` with exactly the two
      budget keys in it; otherwise the generic `notification.hbs` is used for everything.
    - **Done**: a threshold crossing produces exactly **one** email, not two; a user whose
      `emailBudgetAlerts` was `false` before the migration receives none;
      `apps/web/e2e/flow-profile-budget-alerts.spec.ts` still passes.

### API

- [ ] **T14 · P1.** The matrix read and reset endpoints.
    - Create `apps/api/src/notifications/notification-matrix.service.ts` — composes the DTO:
      registry rows (via `NotificationEventTypeRepository`), the user's subscriptions, the user's
      channels (`NotificationChannelRepository.findActiveByUser`), quiet hours, active mutes, and
      the derived `group` per event ([spec FR-1](./spec.md#41-the-matrix)). Reads run in one
      `Promise.all`. Provider labels are resolved through `PluginRegistryService` — **no local
      plugin-id map** (Constitution II).
    - Create `apps/api/src/notifications/notification-matrix.controller.ts` with
      `@Controller('api/notifications')`, `@UseGuards(AuthSessionGuard)`, and
      `GET /matrix` + `POST /matrix/reset`. Reset deletes the caller's subscription rows for the
      named keys (all keys when the body omits `eventKeys`) and returns `{ changed }`.
      `Cache-Control: private, no-store` on the read.
    - Register both in `apps/api/src/notifications/notifications.module.ts`.
    - **Done**: `GET /api/notifications/matrix` returns 23 events, ≥2 columns, and the caller's
      selections; an unauthenticated call is rejected; a reset for another user's key changes
      nothing and reports `changed: 0`.

### Web

- [ ] **T15 · P1.** Extend the typed web client.
    - `apps/web/src/lib/api/notification-preferences.ts` — add `getMatrix()` and
      `resetMatrix(eventKeys?)`, typed against `@ever-works/contracts`. Keep every existing
      method.
    - **Done**: no `any`; `pnpm --filter web type-check` is green.

- [ ] **T16 · P1.** Server actions for the matrix.
    - Create `apps/web/src/app/actions/notification-preferences.ts` with
      `setEventTargets(eventKey, targetIds)` and `resetMatrix(eventKeys?)`, following the
      `ensureAuth()` + `revalidatePath('/', 'layout')` pattern in
      `apps/web/src/app/actions/notification-channels.ts`.
    - `apps/web/src/app/actions/settings.ts` — add an `@deprecated` JSDoc block to
      `updateNotificationPreferences` naming the new file, and a comment stating it is
      unreachable dead code returning a simulated success. **Do not delete it.**
    - **Done**: an unauthenticated invocation redirects to login; the action forwards exactly the
      target list it was given.

- [ ] **T17 · P1.** Matrix components.
    - Create `apps/web/src/components/settings/notifications/` with `NotificationMatrix.tsx`,
      `MatrixGroup.tsx`, `MatrixRow.tsx`, `MatrixSwitch.tsx`, `MatrixColumnHeader.tsx`,
      `MatrixOverflowPicker.tsx`, `QuietHoursRow.tsx`, `ResetDefaultsDialog.tsx`
      ([plan §5.2](./plan.md#52-components--appswebsrccomponentssettingsnotifications)).
    - `NotificationMatrix.tsx` owns: optimistic state, a `Map<eventKey, …>` with a **400 ms**
      debounce (FR-9), an **8 s** `AbortSignal.timeout` that reverts the row (FR-10), per-row
      isolation (FR-11), per-row save state that clears after **2 s** (FR-12), roving tabindex
      with one tab stop, arrow/Home/End/Ctrl+Home/Ctrl+End navigation, `Space`/`Enter` toggle and
      `Shift+Space` row toggle (§6.10), a polite live region, and refetch-on-focus after 30 s
      away (FR-15).
    - `MatrixSwitch.tsx` renders `role="switch"` with `aria-checked`, an accessible name of
      "{column} delivery for {event}", and the disabled+reason states for unverified /
      unconfigured email (S18, S19) and locked persistent rows (FR-23).
    - `MatrixColumnHeader.tsx` shows at most 6 columns and hands the rest to
      `MatrixOverflowPicker.tsx` with a 20-target counter (FR-4, FR-5).
    - **Done**: every visible string comes from `useTranslations('dashboard.settings.notifications')`;
      no component imports the `PROVIDERS` array from
      `apps/web/src/components/settings/NotificationChannelsSettings.tsx`.

- [ ] **T18 · P1.** Rewrite the page's entry component and the page itself.
    - `apps/web/src/components/settings/NotificationPreferencesSettings.tsx` — keep the file and
      the export name; replace the read-only table with a composition of the T17 components.
      Delete the `defaultChecked` checkboxes and the hard-coded English.
    - `apps/web/src/app/[locale]/(dashboard)/settings/notifications/page.tsx` — replace the four
      parallel fetches with `getMatrix()` plus the existing profile read for the Novu subscriber
      hash, keeping `.catch()`-style degradation so a Novu failure cannot blank the page. Render
      the load-error state (§6.5) when the matrix read fails.
    - **Done**: toggling a switch persists across a reload; the page renders with a broken Novu
      config; the empty-registry state renders when the registry is empty.

- [ ] **T19 · P1.** Bell footer link.
    - `apps/web/src/components/dashboard/NotificationDropdown.tsx` — add a footer link to
      `ROUTES.DASHBOARD_SETTINGS_NOTIFICATIONS` (already defined in
      `apps/web/src/lib/constants.ts:265`) using
      `dashboard.header.notifications.settingsLink`. Nothing else in this file changes.
    - **Done**: the settings page is reachable from the product for the first time (spec FR-44).

- [ ] **T20 · P1.** i18n.
    - `apps/web/messages/en.json` — add the `dashboard.settings.notifications` namespace with
      every key listed in [plan §8](./plan.md#8-i18n), using the exact values in
      [spec §6.9](./spec.md#69-exact-user-visible-copy). Add
      `dashboard.header.notifications.settingsLink` and `.mutedFilter`.
    - Add `dashboard.settings.notifications.events.<eventKey>.{title,description,alternativeSurface}`
      for all 23 core keys. Normalise a plugin-namespaced key's `:` to `_` before lookup, and let
      a missing key fall back to the registry string.
    - Mirror the full key set into the 20 sibling locale files in `apps/web/messages/`.
    - **Done**: **no leaf key name contains a literal `.`** (next-intl throws at runtime and reds
      several e2e shards at once); every locale file parses; `pnpm --filter web build` is clean.

### P1 tests

- [ ] **T21 · P1.** Agent-package unit tests.
    - Extend `packages/agent/src/notifications/user-notification-subscription.service.spec.ts`
      (empty selection, `'email'` survival, quiet-hours defer for `'email'`).
    - Extend `packages/agent/src/notifications/notification.service.spec.ts` (`isSilent`,
      persistent-never-silent, the two budget keys).
    - Create `packages/agent/src/facades/__tests__/notification-channel.facade.email-sentinel.spec.ts`
      (no repository call, correct log row, throws for the retry path, missing port fails loudly).
    - **Done**: `cd packages/agent && pnpm test` is green.

- [ ] **T22 · P1.** API controller specs.
    - Create `apps/api/src/notifications/notification-matrix.controller.spec.ts` and
      `apps/api/src/notifications/notification-email-sender.service.spec.ts`.
    - Extend `apps/api/src/notifications/notification-preferences.service.spec.ts` and
      `apps/api/src/notifications/notifications.controller.spec.ts`.
    - Create `apps/api/src/budgets/budget-alert.handler.spec.ts` proving the handler no longer
      sends mail directly.
    - **Done**: `cd apps/api && pnpm test` is green.

- [ ] **T23 · P1.** Web unit tests.
    - Create
      `apps/web/src/components/settings/notifications/NotificationMatrix.unit.spec.tsx` and
      `apps/web/src/app/actions/notification-preferences.unit.spec.ts`.
    - **Done**: four rapid clicks produce one write; a rejected write reverts only its row; the
      grid exposes one tab stop; `cd apps/web && pnpm test` is green.

- [ ] **T24 · P1.** e2e.
    - Create `apps/web/e2e/flow-notification-matrix-autosave.spec.ts` and
      `apps/web/e2e/flow-notification-matrix-email-target.spec.ts` (using the existing
      `apps/web/e2e/helpers/mailhog.ts`).
    - **Done**: both pass locally; the existing suite named in
      [plan §10.4](./plan.md#104-e2e-playwright-appswebe2e) is untouched and still green.

- [ ] **T25 · P1.** Migration test.
    - Add a case under `apps/api/src/migrations/__tests__/` asserting the P1 migration is
      idempotent (23 core registry rows after two runs), contains no `DROP COLUMN` on a
      pre-existing column, and issues no `UPDATE` against `users`.
    - **Done**: the case fails if someone adds a destructive statement to the migration.

---

## Phase P2 — the attention budget

### Data model

- [ ] **T26 · P2.** Budget columns on the preference row.
    - `packages/agent/src/entities/user-notification-preference.entity.ts` — add
      `attentionBudgetEnabled: boolean` (default `true`), `emailDailyBudget: number` (int,
      default `10`), `channelDailyBudget: number` (int, default `20`).
    - **Done**: a user with no preference row still resolves to the same three defaults in code.

- [ ] **T27 · P2.** The hold entity and its repository.
    - Create `packages/agent/src/entities/attention-hold.entity.ts` (`attention_holds`) with the
      columns and two indexes in [plan §3.2b](./plan.md#32--p2--appsapisrcmigrations1791130100000-createattentionholdsts).
      Use `PortableDateColumn` from `packages/agent/src/entities/_types.ts` for every timestamp,
      as `notification-channel-delivery-log.entity.ts` already does, so the SQLite test driver
      keeps working.
    - Create `packages/agent/src/database/repositories/attention-hold.repository.ts` with
      `create`, `countOpenForUser`, `listOpenForUser(userId, limit)`,
      `markReleased(ids, at)`, `deleteExpired(now)`.
    - Export the entity from `packages/agent/src/entities/index.ts` and the repository from
      `packages/agent/src/database/index.ts`, beside the other notification repositories.
    - **Done**: the entity is registered in the TypeORM entity list used by both the API and the
      test harness; `pnpm --filter @ever-works/agent type-check` is green.

- [ ] **T28 · P2.** Ship the migration for T26 + T27, in the same PR.
    - `apps/api/src/migrations/1791130100000-CreateAttentionHolds.ts` — three `ADD COLUMN … NOT
      NULL DEFAULT` on `user_notification_preferences`, `CREATE TABLE attention_holds` with its
      FK to `users` (`ON DELETE CASCADE`) and its two indexes.
    - **Done**: `up()` has no `DROP`, no rename, no backfill; `down()` reverses exactly it;
      running against a seeded local DB completes without locking
      `user_notification_preferences`.

### Admission

- [ ] **T29 · P2.** The budget service.
    - Create `packages/agent/src/notifications/attention-budget.service.ts` with
      `admit(userId, plan, event, payload): Promise<{ deliver: string[]; held: string[] }>`.
    - Counting: `COUNT(DISTINCT "messageRef")` over
      `notification_channel_delivery_log` where `userId = :userId`,
      `createdAt >= now() - 24h`, `status <> 'dropped'`, split by
      `builtInChannel = 'email'` versus `channelId IS NOT NULL`.
    - Rules: urgent events are always admitted and still increment the count (FR-31); a target
      over its class ceiling is held (FR-32); `in-app` is never counted (FR-30); a disabled budget
      admits everything (FR-35); **any error in the count admits the delivery** (fail open,
      [plan §9.2](./plan.md#92-failure-modes)).
    - Create `packages/agent/src/notifications/__tests__/attention-budget.service.spec.ts` for
      every rule above plus the 24 h boundary and the `0` ceiling.
    - **Done**: the service has no HTTP, no mail and no Trigger import; the spec is green.

- [ ] **T30 · P2.** Wire admission into the fan-out.
    - `apps/api/src/notifications/notification-fanout.listener.ts` — between
      `resolvePlan(...)` and `channelFacade.send(...)`, call `AttentionBudgetService.admit(...)`;
      pass only the admitted targets to the facade and write an `attention_holds` row per held
      target. Keep the `suppressErrors: true` posture — a budget fault must never surface to the
      producer.
    - `apps/api/src/notifications/notifications.module.ts` — provide the budget service and the
      hold repository.
    - **Done**: with the email ceiling at 1, two non-urgent events produce one email and one hold;
      an urgent event still sends.

### Release and expiry

- [ ] **T31 · P2.** The digest releases holds.
    - `packages/agent/src/digest/digest.service.ts` — in `renderMarkdown`, add a **Held for you**
      section after the existing "Needs your decision" section, listing at most
      `MAX_ITEMS_PER_SECTION` (the constant already in that file) named holds plus a remainder
      count, and an **Attention** one-liner with the two used/limit pairs.
    - In `deliverDigest` (and `deliverOrgDigest` — personal holds only, never org-wide), read open
      holds, include them, and call `markReleased` **only after** the notification producer
      returns successfully.
    - `packages/agent/src/digest/digest.types.ts` — extend `DigestCounts` with `heldReleased:
      number`, and include held items in the non-quiet calculation exactly as `escalationsOpen`
      already is, so a window whose only content is held items is not suppressed.
    - Create `packages/agent/src/digest/__tests__/digest-holds.spec.ts`.
    - **Done**: a held item appears by name in one digest and not the next; a compose failure
      leaves the hold open.

- [ ] **T32 · P2.** Expire holds on the existing cron.
    - `apps/api/src/notifications/notification-cleanup.service.ts` — inside the existing
      `@Cron(EVERY_DAY_AT_3AM)` body and the existing
      `DistributedTaskLockService.runExclusive` block, call
      `AttentionHoldRepository.deleteExpired(now)` and add its count to the log line.
    - **Done**: no new cron, no new dispatcher symbol, no new Trigger task; a hold older than
      7 days is deleted and never delivered.

### API and UI

- [ ] **T33 · P2.** Budget and hold endpoints.
    - `apps/api/src/notifications/notification-matrix.controller.ts` — add
      `GET /attention-budget`, `PUT /attention-budget` (DTO class with `@IsBoolean()` and two
      `@IsInt() @Min(0) @Max(200)` fields), and `GET /held?limit` (cap 50).
    - `GET /matrix` embeds the same budget snapshot so the page needs one read on first paint
      (FR-6).
    - **Done**: `-1` and `201` are both rejected with the limit in the message; `GET /held`
      returns only the caller's holds and 404s nothing (it is a list).

- [ ] **T34 · P2.** Budget UI.
    - Create `apps/web/src/components/settings/notifications/AttentionBudgetCard.tsx` and
      `HeldItemsDisclosure.tsx` — two meters, the reset countdown, the 60 s poll that pauses while
      the tab is hidden, the edit-limits dialog (§6.7), and the off / zero / over copy (§6.6).
    - `apps/web/src/lib/api/notification-preferences.ts` — add `getAttentionBudget`,
      `setAttentionBudget`, `listHolds`.
    - `apps/web/src/app/actions/notification-preferences.ts` — add `setAttentionBudget`.
    - Add the `budget.*` and the holds-related i18n keys to `apps/web/messages/en.json` and the
      20 siblings.
    - Create `apps/web/src/components/settings/notifications/AttentionBudgetCard.unit.spec.tsx`.
    - **Done**: the over, zero and off states render their exact copy; the poll stops on hide.

- [ ] **T35 · P2.** Program vocabulary.
    - `docs/specs/features/agent-workspace/README.md` — add **Attention hold** to the §1
      vocabulary table with its one-line definition and "do not introduce" column, per the
      program's own rule that a new entity is registered in the same PR.
    - **Done**: the table names the entity and points at this epic.

- [ ] **T36 · P2.** e2e.
    - Create `apps/web/e2e/flow-attention-budget.spec.ts` — ceiling of 1, two non-urgent events,
      one mail and one hold; an urgent event still sends; the meter reads the right numbers.
    - **Done**: green locally; `flow-notifications-digest.spec.ts` and
      `flow-notifications-event-preferences-digest-chain.spec.ts` still pass.

---

## Phase P3 — the edges

- [ ] **T37 · P3.** Weekly digest for new accounts.
    - `packages/agent/src/entities/user.entity.ts` — change `digestFrequency`'s column default
      from `'off'` to `'weekly'`.
    - Create `apps/api/src/migrations/1791130200000-DigestDefaultWeekly.ts` with a single
      `ALTER TABLE "users" ALTER COLUMN "digestFrequency" SET DEFAULT 'weekly'` and a comment
      stating that **no `UPDATE` is intentional** (spec FR-40).
    - **Done**: a freshly registered user has `weekly`; every existing row is unchanged.

- [ ] **T38 · P3.** Test email.
    - `apps/api/src/notifications/notification-matrix.controller.ts` — add
      `POST /test-email` with `@Throttle({ default: { limit: 3, ttl: 600_000 } })`, routed through
      the same sender the real path uses.
    - `apps/web/src/components/settings/notifications/` — add the link and the inline
      sent/failed/throttled states, with copy from §6.9.
    - **Done**: a fourth call inside 10 minutes is refused with the numbers in the message.

- [ ] **T39 · P3.** Muted filter on the bell.
    - `apps/web/src/components/dashboard/NotificationDropdown.tsx` — add a **Muted** toggle that
      refetches with `includeSilent=true`. The 30 s unread poll, the toast behaviour and the lazy
      list fetch stay exactly as they are.
    - **Done**: a silent notification is invisible by default and visible under the filter.

- [ ] **T40 · P3.** Truthful digest copy.
    - `apps/web/messages/en.json` (+ 20 siblings) — correct
      `dashboard.settings.digest.fields.enabledHelper`, which currently claims delivery "to any
      notification channel you have connected" for an event that was never registered.
    - `apps/web/src/components/settings/DigestSettings.tsx` — add a link to the matrix's digest
      row.
    - **Done**: the page's claim matches what the matrix actually routes.

- [ ] **T41 · P3.** Accessibility e2e.
    - Create `apps/web/e2e/flow-notification-matrix-a11y.spec.ts` — one tab stop, arrow
      traversal, accessible names, the live region announcing "Saved".
    - **Done**: green.

---

## Docs and rollout

- [ ] **T42.** User-facing documentation.
    - Create `docs/features/notifications.md` covering the matrix, the four groups and why the
      defaults are what they are, the attention budget, holds and the digest, quiet hours and
      mutes.
    - Add `'features/notifications'` to `apps/docs/sidebarsPlatform.ts` immediately after
      `'features/activity'`; cross-link from `docs/features/activity.md` and
      `docs/features/budgets-and-usage.md`.
    - **Done**: `pnpm --filter ever-works-docs build` produces no broken-link warnings.

- [ ] **T43.** Tracker and status.
    - `docs/specs/features/agent-workspace/TRACKER.md` — set AW-13's **Spec** column to `Draft`
      on this PR, then update **Impl** as each phase lands.
    - Set this file's and `plan.md`'s status to `Done`, and `spec.md`'s to `Implemented`, only
      after P2 lands.

- [ ] **T44.** Resolve the open questions.
    - Take [spec §9](./spec.md#9-open-questions) to Product before P2 starts. The rolling-window
      question (T29) and the budget-alert template question (T13) both block a task above; the
      rest can land as follow-ups.

- [ ] **T45.** Full gate.
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the repo root.
    - `cd apps/web && pnpm test:e2e` for the 4 new specs plus the 8-spec regression set named in
      [plan §10.4](./plan.md#104-e2e-playwright-appswebe2e).

---

## Definition of done

- Every checkbox above is ticked for the phase being shipped.
- Every acceptance criterion in [spec §8](./spec.md#8-acceptance-criteria) is demonstrably true on
  a local stack.
- Every gate in [plan §12](./plan.md#12-constitution-compliance) is still ✅ after the code exists,
  not only in the plan.
- No user-visible string on any touched surface is hard-coded English.
- No producer emits an event key without a registry row — enforced by T4, not by review.
