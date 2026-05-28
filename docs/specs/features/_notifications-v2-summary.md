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

### Partially done (next session)

- **EW-673** Channel data + controller + agent tool — controller + data done (T10, T12), `notifyChannel` agent tool descriptor pending
- **EW-674** Discord/Slack/Telegram plugins — Discord done (T15), Slack + Telegram pending
- **EW-678** Producer fanout + UI matrix — REST + UI done (T12, T17); producer fanout call from v1 `notify*` methods pending
- **EW-680** Per-Agent inbox tab + components — list view done (T17); message detail page + composer page pending
- **EW-681** SWR hooks + SSE + i18n + E2E — API clients done (T17); SWR client hooks + SSE stream + i18n + Playwright E2E pending

### Not started (next session)

- **EW-670** Agent integration: `sendEmail` + `messageAgent` tools + dispatcher + git facade
- **EW-675** WhatsApp + Novu channel plugins

### Newly done (this overnight cron loop)

- **T20 EW-678** Producer fanout — [`ead297eb`](https://github.com/ever-works/ever-works/commit/ead297eb)
- **T21 EW-676** Event registry seed + plugin manifest events extension — [`126499ff`](https://github.com/ever-works/ever-works/commit/126499ff) + [`d1118ce6`](https://github.com/ever-works/ever-works/commit/d1118ce6)
- **T22 EW-677** Subscription resolver (`resolveChannels` + quiet-hours + mute) — *this commit*. BullMQ delayed-delivery + org-defaults fallback deferred (TODO in service). Listener now uses the real resolver instead of the T20 stub.

## ⚠ Known issue found during T22 — apps/api repo method mismatch

The custom repository classes under `packages/agent/src/database/repositories/`
expose **semantic methods** (`findByKey`, `findForEvent`, `findByUser`,
`isMuted`, `upsert`, …), NOT raw TypeORM `findOne`/`find`/`save`/`create`/`remove`.

The T12 services — `apps/api/src/email/email.service.ts`,
`apps/api/src/notification-channels/notification-channels.service.ts`,
`apps/api/src/notifications/notification-preferences.service.ts` — were written
assuming the raw TypeORM API and **will not compile** against the actual repo
classes. The `EmailFacadeService` / `NotificationChannelFacadeService` (T11) have
the same issue where they call `.findOne` / `.find` / `.save` / `.create` on the
new repos.

**Fix required (next dedicated tick before any PR):** either (a) add the missing
semantic methods to each repository, or (b) expose the underlying TypeORM
`Repository` and call through it. Option (a) matches the existing house style.
The agent-package resolver (T22) + all 3 plugins are clean; this is contained to
the api-layer services + the two facades.

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
