---
id: budgets-and-usage
title: Budgets & Usage
sidebar_label: Budgets & Usage
---

# Budgets & Usage

Every AI call the platform makes — generating a Work, refreshing Ideas, running a Mission tick, building from an Idea — costs money. **Budgets** let you cap that spend at three scopes: per-Work, per-Mission, per-Idea, and account-wide.

Hit a cap and the next AI call is **blocked** (or **alerted**, depending on configuration) before it runs, not after the bill arrives.

## What gets counted

Each AI call records a usage row tagged with:

- The **plugin** that ran (`openai`, `anthropic`, `tavily`, etc.)
- The **owner** — what the cost should bill against
- The token / request counts the plugin reported back
- A cents-denominated cost computed from the plugin's price list

Owner types:

| Owner type  | When it's used                                                             |
| ----------- | -------------------------------------------------------------------------- |
| **work**    | Calls made during a Work's generation pipeline.                            |
| **mission** | Calls made by a Mission tick (Idea research) or by a Mission's auto-build. |
| **idea**    | Calls made while building a specific Idea into a Work.                     |
| **account** | Account-wide aggregates (no specific owner).                               |

The same call can roll up at multiple scopes — a Mission-auto-build call counts against the **Idea** budget AND the **Mission** budget AND your **account-wide** total.

## Account-wide caps

The **Month Spend** tile on the dashboard shows your current calendar-month total + the global cap (if set). Click through to the full usage breakdown under Settings.

| Cap setting                    | What it does                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `accountMaxSpendCentsPerMonth` | Hard cap. Every new AI call checks this first and refuses if over.                  |
| `accountAllowOverage`          | When true, the cap is advisory — you're alerted but not blocked.                    |
| `accountAlertAtPercent`        | Trigger an in-app notification + email when spend crosses this fraction of the cap. |

Set under **Settings → Account → Usage & Budget**.

## Per-Mission caps

Each Mission can carry its own budget guardrails (separate from the account-wide cap). Set them at create time, on the detail page, or inherit them from a [Mission Template's manifest](./mission-templates#the-worksmissionyml-manifest).

| Guardrail                         | What it caps                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `maxWorksPerRun`                  | How many Works a single Mission tick can spawn / queue.                          |
| `maxItemsPerWork`                 | How many items each spawned Work's generation can produce.                       |
| `maxBudgetCentsPerRun`            | Hard spend cap for one Mission tick.                                             |
| `requireApprovalBeforeCreate`     | Hold builds in a `BUILDING-APPROVAL` state until you click **Approve**.          |
| `requireApprovalBeforeDelete`     | Same, for destructive ops.                                                       |
| `requireApprovalAboveBudgetCents` | Approval kicks in only when the spend forecast crosses this threshold.           |
| `dryRunByDefault`                 | Run the Mission tick without making real AI calls — useful for testing the loop. |

These are **additive** — the strictest among Mission / account-wide / per-Work guardrails wins.

## Per-Idea + per-Work budgets

The Mission detail page surfaces a **Budget** card showing current-period spend, the cap that applies, and the percentage used. The same card appears on the Idea detail and Work detail pages with the same shape (the underlying API returns identical envelopes regardless of owner type).

The card shows:

- **Current spend** — cents spent this billing period for this owner.
- **Cap** — the most restrictive cap that applies (per-owner if set, else account-wide).
- **% used** — current ÷ cap, or `null` if no cap.
- **Blocked** — true when the next call would refuse.

If the cap is `null` (no cap set), no percentage is shown and the card just renders the current spend.

## Billing modes

A scheduled Work's runs can be billed in one of two modes:

- **USAGE** (default) — every run draws from your account credits.
- **PRO-RATA** — fixed monthly allowance you set per Work, computed across the schedule.

Pick at the Work-Schedule level. Mission auto-builds always run in USAGE mode (per-Work pro-rata doesn't fit the spawn-on-demand pattern).

## What happens when a cap is hit

Order of precedence on each call:

1. **Mission `maxBudgetCentsPerRun`** — if set, refuses early in the tick.
2. **Account-wide cap** — checked next. Refuses if `accountAllowOverage=false`; otherwise alerts.
3. **Per-Work budget** — checked at generation-step granularity.

A refusal:

- Marks the parent operation as `blocked` (Mission tick → `status: blocked`; Idea build → `status: failed, failureKind: budget-blocked`).
- Records the would-have-spent amount in `plugin_usage` with a `blocked=true` flag so the dashboard reflects "intended" spend, not just actual.
- Triggers the budget-alert handler (in-app notification + email + analytics event).

An alert without refusal (overage allowed):

- Same `blocked` flag is **false**.
- The call proceeds and the actual spend lands on the usage row.

## Where the numbers come from

Plugin price lists are baked into each plugin's `package.json` under `everworks.plugin.pricing`. When a plugin returns token counts, the platform multiplies them by the per-1K-token price to produce a cents value. Plugins that don't surface usage (e.g. cached responses) record zero-cost rows so the operation still has an audit trail.

## API

| Verb               | Endpoint                                |
| ------------------ | --------------------------------------- |
| Account-wide usage | `GET /api/me/usage/account-wide`        |
| Per-Mission budget | `GET /api/me/missions/:id/budget`       |
| Per-Idea budget    | `GET /api/me/work-proposals/:id/budget` |
| Per-Work budgets   | `GET /api/works/:workId/budgets`        |
| Per-Work usage     | `GET /api/works/:workId/usage`          |

Same routes are exposed as MCP tools (`get_account_usage`, `get_mission_budget`, `get_idea_budget`) — see the [MCP Server](./mcp-server) docs.

## Where to go next

- [Missions](./missions) — where Mission-level guardrails are set.
- [Mission Templates](./mission-templates) — how a template's manifest seeds the spawned Mission's guardrails.
- [Scheduled Updates](./scheduled-updates) — billing-mode choices for Work schedules.
