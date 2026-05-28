# Notifications v2 — overnight run state

**Branch**: `feat/notifications-v2-multichannel` (off `origin/develop` HEAD `3ee54a27`)
**Worktree**: `C:/Coding/Worktrees/wt-notifications-v2`
**Started**: 2026-05-28 03:30 UTC+3 (Europe/Kyiv)
**Operator decisions (confirmed)**:
1. Three new sibling epics + extend EW-650 (Recommended) — keeps EW-650 focused on email; new siblings for channels, subscriptions, inbox UI.
2. Overnight scope: Specs + JIRA + scaffolding + Postmark + Resend + Discord + UI shell (Phase 1+).
3. NOT merged to develop. Commit + push per tick on the feature branch only.

## What's already landed (commits on branch)

| Commit | Tick | What |
|--------|------|------|
| `96b1f77c` | T2 | Extended `email-providers/spec.md` to v1.1 (React-Email + agent-to-agent + sibling refs) |
| `1da09749` | T3 | Added `email-providers/plan.md` + `tasks.md` |
| `db723688` | T4 | New `notification-channels/{spec,plan,tasks}.md` |
| `e4cbec9f` | T5 | New `event-subscriptions/{spec,plan,tasks}.md` |
| `b04fbb5f` | T6 | New `agent-inbox-ui/{spec,plan,tasks}.md` |

## JIRA state

| Issue | Type | Summary | Status |
|-------|------|---------|--------|
| [EW-650](https://evertech.atlassian.net/browse/EW-650) | Epic | Email Providers (updated to v1.1) | To Do |
| [EW-663](https://evertech.atlassian.net/browse/EW-663) | Epic | Notification Channels | To Do |
| [EW-664](https://evertech.atlassian.net/browse/EW-664) | Epic | Event Subscriptions | To Do |
| [EW-665](https://evertech.atlassian.net/browse/EW-665) | Epic | Per-Agent Inbox UI | To Do |
| [EW-666](https://evertech.atlassian.net/browse/EW-666) ‥ [EW-681](https://evertech.atlassian.net/browse/EW-681) | Task | 16 child tickets across 4 epics | To Do |

## Remaining ticks (still to execute on this branch tonight)

- **T9** Backend: plugin capabilities + base interfaces (EW-666)
- **T10** Backend: TypeORM entities + migration (EW-667)
- **T11** Backend: EmailFacadeService + NotificationChannelFacadeService stubs (EW-668, EW-672)
- **T12** Backend: API controllers + webhook routes (EW-669, EW-673)
- **T13** Plugin: postmark (reference impl, outbound + inbound) — part of EW-671
- **T14** Plugin: resend (outbound only) — part of EW-671
- **T15** Plugin: discord-channel — part of EW-674
- **T16** UI: install @react-email/components + base templates — part of EW-679
- **T17** UI: settings/integrations/emails page shell + agent inbox panel — EW-679, EW-680
- **T18** Tests: smoke + integration tests, type-check, lint
- **T19** Final: README per epic + push final branch state

## Hand-off

Ticks T9–T19 are executed by a background subagent with a comprehensive briefing.
Each tick = one commit, pushed to `feat/notifications-v2-multichannel`.
This file (`_notifications-v2-state.md`) will be deleted in T19's final commit (or left if useful as audit trail).
