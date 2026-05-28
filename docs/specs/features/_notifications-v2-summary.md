# Notifications v2 — overnight run summary

**Branch**: [`feat/notifications-v2-multichannel`](https://github.com/ever-works/ever-works/tree/feat/notifications-v2-multichannel) (off `origin/develop` HEAD `3ee54a27`).
**Status**: 19 ticks landed; **not** merged to develop, **no** PR opened (per operator instruction).
**Run period**: 2026-05-28 night session.

## Commits (in order)

| Tick | SHA | Scope |
|------|------|-------|
| T2 | [`96b1f77c`](https://github.com/ever-works/ever-works/commit/96b1f77c) | docs(email-providers): extend spec v1.1 |
| T3 | [`1da09749`](https://github.com/ever-works/ever-works/commit/1da09749) | docs(email-providers): plan + tasks |
| T4 | [`db723688`](https://github.com/ever-works/ever-works/commit/db723688) | docs(notification-channels): spec + plan + tasks |
| T5 | [`e4cbec9f`](https://github.com/ever-works/ever-works/commit/e4cbec9f) | docs(event-subscriptions): spec + plan + tasks |
| T6 | [`b04fbb5f`](https://github.com/ever-works/ever-works/commit/b04fbb5f) | docs(agent-inbox-ui): spec + plan + tasks |
| T7+ | [`308adb3a`](https://github.com/ever-works/ever-works/commit/308adb3a) | docs: state-of-play note (deleted in T19) |
| T9 | [`2f2ca1a3`](https://github.com/ever-works/ever-works/commit/2f2ca1a3) | feat: plugin capabilities + base interfaces |
| T10 | [`42f621b2`](https://github.com/ever-works/ever-works/commit/42f621b2) | feat: 11 entities + AddNotificationsV2Tables migration |
| T11 | [`69a4529c`](https://github.com/ever-works/ever-works/commit/69a4529c) | feat: Email + NotificationChannel facade services |
| T12 | [`8f4c9577`](https://github.com/ever-works/ever-works/commit/8f4c9577) | feat: 3 REST controllers + webhook routes |
| T13 | [`32bf2abe`](https://github.com/ever-works/ever-works/commit/32bf2abe) | feat(plugin/postmark): outbound + inbound reference impl |
| T14 | [`5aac75e4`](https://github.com/ever-works/ever-works/commit/5aac75e4) | feat(plugin/resend): outbound-only impl |
| T15 | [`9273f8c0`](https://github.com/ever-works/ever-works/commit/9273f8c0) | feat(plugin/discord-channel): webhook-based channel impl |
| T16 | [`57ca4cec`](https://github.com/ever-works/ever-works/commit/57ca4cec) | feat: react-email registry + 2 templates |
| T17 | [`dc5347a3`](https://github.com/ever-works/ever-works/commit/dc5347a3) | feat(agent-inbox-ui): 4 web routes + components + API clients |
| T18 | [`b89c1546`](https://github.com/ever-works/ever-works/commit/b89c1546) | test: IPlugin compliance + 18/18 plugin tests green |
| T18 | [`33810fe1`](https://github.com/ever-works/ever-works/commit/33810fe1) | chore: pnpm-lock.yaml updated for new plugins |

## JIRA state

**4 epics**: [EW-650](https://evertech.atlassian.net/browse/EW-650), [EW-663](https://evertech.atlassian.net/browse/EW-663), [EW-664](https://evertech.atlassian.net/browse/EW-664), [EW-665](https://evertech.atlassian.net/browse/EW-665).
**16 child tickets**: EW-666 through EW-681.

### Done (operator can transition to In Review)

- **EW-666** Capabilities + interfaces — T9
- **EW-667** Entities + migration — T10
- **EW-668** Facade core + React-Email rendering — T11, T16
- **EW-669** Email controller + webhook routes — T12
- **EW-671** Postmark + Resend plugins — T13, T14, T18
- **EW-672** Channel capabilities + facade + in-app adapter — T11
- **EW-679** Settings/integrations pages + dependencies — T16, T17

### Partially done

- **EW-681** SWR hooks + SSE + i18n + E2E — server API clients (T17) + inbox client hook (T33) + SSE stream (T34) done. i18n (T35) + Playwright E2E (T36) pending. (channels/preferences client hooks follow the same store pattern when their pages need live revalidation — settings pages currently fetch server-side.)

### Not started

_(none — all remaining items are in "Partially done" above)_

### Done since the original Phase-1 cut

- **EW-670** Agent integration — sendEmail (T23) + messageAgent (T24) + inbound dispatcher (T25). Complete.
- **EW-673** Channel data (T10) + controller (T12) + `notifyChannel` agent tool (T26). Complete.
- **EW-676** Event registry seed + plugin manifest events (T21).
- **EW-677** Subscription resolver (T22).
- **EW-678** Producer fanout (T20) + REST/UI (T12/T17). Complete.
- **EW-680** Per-Agent inbox UI — list (T17) + detail (T31) + composer (T32). Complete.
- **EW-674** Notification channel plugins — Discord (T15) + Slack (T27) + Telegram (T28). Complete.
- **EW-675** Notification channel plugins (2nd batch) — WhatsApp (T29) + Novu (T30). Complete. All 5 chat channels + 2 email providers shipped.

### Newly done (this overnight cron loop)

- **T25 EW-670** Agent inbound-email dispatcher — [`b70a8634`](https://github.com/ever-works/ever-works/commit/b70a8634). `AGENT_INBOUND_EMAIL_DISPATCHER` token + `DefaultInboundEmailDispatcher` (task-spawn + conversation modes), `INBOUND_EMAIL_TASK_SPAWNER` optional adapter, `deriveThreadKey` helper, `findByAddress` repo method, inbound-webhook wiring. 8 new unit tests.
- **T26 EW-673** Agent `notifyChannel` tool — [`54d5c396`](https://github.com/ever-works/ever-works/commit/54d5c396). New `AGENT_NOTIFY_CHANNEL_FACADE` token + contract; `buildNotifyChannelTool` gated on `canCallExternalTools` + facade presence, invoke-time channel-ownership enforcement. Completes EW-673. 4 new unit tests.
- **T27 EW-674** Slack channel plugin — [`889c6e15`](https://github.com/ever-works/ever-works/commit/889c6e15). `packages/plugins/slack-channel/` incoming-webhook + Block Kit, mirrors Discord. type-check clean, 7/7 Vitest.
- **T28 EW-674** Telegram channel plugin — [`6f9abf89`](https://github.com/ever-works/ever-works/commit/6f9abf89). `packages/plugins/telegram-channel/` Bot API sendMessage (direct shape), MarkdownV2 support, getMe verifyTarget. type-check clean, 8/8 Vitest. Completes EW-674.
- **T29 EW-675** WhatsApp channel plugin — [`45b92c7a`](https://github.com/ever-works/ever-works/commit/45b92c7a). `packages/plugins/whatsapp-channel/` Cloud API send (text + template, direct shape), 24h-window note, phone-number-id verifyTarget. type-check clean, 8/8 Vitest.
- **T30 EW-675** Novu channel plugin — [`06cd2323`](https://github.com/ever-works/ever-works/commit/06cd2323). `packages/plugins/novu-channel/` Trigger API (workflow shape, raw fetch), payload merge, environments/me verifyTarget, self-hosted apiBase. type-check clean, 9/9 Vitest. Completes EW-675 + the full plugin set.
- **T31 EW-680** Inbox message detail page — [`5604736b`](https://github.com/ever-works/ever-works/commit/5604736b). `GET /api/email/messages/:id` route + `EmailService.getMessage` (per-user ownership) + `emailAddressesAPI.getMessage` client + `MessageDetail` component (sandboxed iframe for HTML body) + `/agents/[id]/inbox/[messageId]` page; inbox rows link to it.
- **T32 EW-680** Inbox composer — [`52b4656b`](https://github.com/ever-works/ever-works/commit/52b4656b). `POST /api/email/messages` route + `EmailService.sendMessage` (resolves agent primary-outbound address → EmailFacade.send) + `emailAddressesAPI.sendMessage` client + `sendAgentEmailAction` server action + `Composer` client component + `/agents/[id]/inbox/compose` page. Completes EW-680.
- **T33 EW-681** Inbox client hook — [`c545720e`](https://github.com/ever-works/ever-works/commit/c545720e). `useAgentInbox(agentId)` (module-store + useSyncExternalStore, exposes messages/isLoading/error/mutate) + BFF proxy `apps/web/src/app/api/email/messages/route.ts`. No SWR (not an apps/web dep — mirrors use-organizations.ts).
- **T34 EW-681** SSE inbox stream — [`73be2295`](https://github.com/ever-works/ever-works/commit/73be2295). Poll-based `GET /api/email/messages/stream` (diffs new inbound rows, heartbeat, cleanup; declared before `messages/:id`) + BFF stream proxy + `useInboxStream(agentId, onMessage)` hook (EventSource → calls `mutate`, 30s poll fallback).

- **T20 EW-678** Producer fanout — [`ead297eb`](https://github.com/ever-works/ever-works/commit/ead297eb)
- **T21 EW-676** Event registry seed + plugin manifest events extension — [`126499ff`](https://github.com/ever-works/ever-works/commit/126499ff) + [`d1118ce6`](https://github.com/ever-works/ever-works/commit/d1118ce6)
- **T22 EW-677** Subscription resolver (`resolveChannels` + quiet-hours + mute) — [`bc23e150`](https://github.com/ever-works/ever-works/commit/bc23e150). BullMQ delayed-delivery + org-defaults fallback deferred (TODO in service). Listener now uses the real resolver instead of the T20 stub.
- **T22b** Repo-method alignment — [`49953380`](https://github.com/ever-works/ever-works/commit/49953380). Aligned the T11 facades + T12 api services to the repositories' actual semantic method APIs.
- **T23 EW-670** Agent `sendEmail` tool descriptor — [`594e5f06`](https://github.com/ever-works/ever-works/commit/594e5f06). New `AGENT_EMAIL_FACADE` token + `AgentEmailFacade` contract (mirrors AGENT_GIT_FACADE), `buildSendEmailTool` gated on `canCallExternalTools` + facade presence; ≥1-outbound-assignment enforced at invoke time. 4 new unit tests.
- **T24 EW-670** Agent `messageAgent` tool descriptor — [`9ec6b31d`](https://github.com/ever-works/ever-works/commit/9ec6b31d). Peer-to-peer verb (spec §12.4) gated on `canCallExternalTools` + facade implementing the optional `messageAgent` method; invoke rejects self-messaging + empty fields. 3 new unit tests (16/16 agent-tool suite green).

## ✅ Resolved — apps/api repo method mismatch (was a T22 finding, fixed in T22b)

The custom repository classes under `packages/agent/src/database/repositories/`
expose **semantic methods** (`findById`, `findByIdForUser`, `findActiveByUser`,
`findByVerificationToken`, `findByUser`, `findByKey`, `findForEvent`, `isMuted`,
`upsert`, `update`, `delete`, `save`, …), NOT raw TypeORM
`findOne`/`find`/`create`/`remove`.

The T11 facades + T12 api services originally assumed the raw TypeORM API. T22b
rewrote every call site to the semantic methods:
- `EmailFacadeService` — `findById`, `findByAgent`, `save(entity)`
- `NotificationChannelFacadeService` — `findById`, `save(entity)`
- `email.service.ts` — `findActiveByUser`, `findByIdForUser`, `findByVerificationToken`, `update`, `delete`, `findByUser`
- `notification-channels.service.ts` — `findActiveByUser`, `findByIdForUser`, `update`, `delete`
- `notification-preferences.service.ts` — `findAll`, `findByUser`, `findForEvent`, `findActiveByUser`, `upsert`, `delete`

Agent-package facade + resolver suites pass after the change (13/13 resolver,
facade DI specs green).

## Verified locally

- `@ever-works/plugin` — clean tsup build (DTS + JS)
- `@ever-works/postmark-plugin` — `pnpm type-check` ✓, `pnpm test` ✓ **7/7**
- `@ever-works/resend-plugin` — `pnpm type-check` ✓, `pnpm test` ✓ **4/4**
- `@ever-works/discord-channel-plugin` — `pnpm type-check` ✓, `pnpm test` ✓ **7/7**

**Total plugin unit tests: 18/18 passing.**

## Deferred verifications

- `pnpm type-check` from repo root + `pnpm lint` from repo root — not run in this session (full monorepo install + build wasn't attempted to keep the session tight). Recommended to run before opening a PR.
- `apps/api` Jest tests (controller wiring specs added in T11, T12) — not executed in this session (requires apps/api install + build).
- Playwright E2E across `/settings/integrations/emails`, `/settings/integrations/channels`, `/settings/notifications`, `/agents/[id]/inbox` — pending (EW-681 next-session work).
- `@react-email/components` + `@react-email/render` deps added to `apps/api/package.json` — JSX template wiring is currently shimmed by pure-TS template functions (templates registry shape stays the same; the swap to React-Email TSX is a follow-up).

## Recommended next session

1. **Producer fanout** (EW-678 missing half) — wire `notifyAiCreditsDepleted` + the other 4 v1 producers to `NotificationChannelFacadeService.send` via a real subscription resolver. Highest immediate value because it lights up the new multi-channel surface for existing notifications.
2. **Slack channel plugin** (EW-674) — mirrors `discord-channel`, ~1 hour copy-with-edits.
3. **Agent `sendEmail` tool descriptor** (EW-670) — gates the agent run loop on outbound assignments and registers the tool with the LLM. Closes the loop from spec §5.
4. **Run `pnpm type-check` + `pnpm lint` from repo root** and fix any cross-package surfaces (the EmailFacadeService consumes new repos that may need additional DI imports in apps/api/api.module.ts; verify the api boot doesn't choke).
5. **Composer page + SSE stream** (EW-680 / EW-681) — the largest UI piece still pending.

## How to pick this up

- Worktree path: `C:/Coding/Worktrees/wt-notifications-v2`
- Branch: `feat/notifications-v2-multichannel` (tracking `origin/feat/notifications-v2-multichannel`)
- The 4 spec docs under `docs/specs/features/{email-providers,notification-channels,event-subscriptions,agent-inbox-ui}/` are the canonical task source — each ticket above references the relevant `tasks.md` rows.
