---
id: credits-and-billing
title: Credits & Billing
sidebar_label: Credits & Billing
---

# Credits & Billing

**Credits** are the platform's unit of consumption. Agent runs, pipelines and AI calls debit them; the daily allowance, the monthly plan allowance and purchases add them. Two settings pages read this data: **Billing** for the plan, the balance and the ledger, and **Usage & Credits** for where the money went. The full behaviour spec is [`docs/specs/features/billing/spec.md`](../specs/features/billing/spec.md).

Credits are complementary to [Budgets](./budgets-and-usage.md), not a replacement: budgets cap _spend at a scope before a call runs_; credits are the account-level balance the platform meters against.

## The ledger is the source of truth

There is no separate balance column. Your balance is the **sum of your ledger movements**, so the number and its explanation can never disagree.

| Entry kind    | Sign | What it is                                                                                       |
| ------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `purchase`    | +    | A top-up or auto-recharge confirmed by the billing provider. Never expires.                      |
| `grant`       | +    | The monthly plan allowance (3,000 Pro / 25,000 Enterprise), expiring at the allowance-month end. |
| `daily-free`  | +    | The daily allowance (50 on every plan), topped up to the level — never accumulating.             |
| `consumption` | −    | Metered usage, rolled up per run / Task.                                                         |
| `adjustment`  | ±    | Platform correction (e.g. a refund reversal).                                                    |
| `expiry`      | −    | The unconsumed part of an allowance bucket that lapsed.                                          |

### Buckets and what gets spent first

Every positive row is a **bucket** with a remaining amount and an optional expiry. A debit is taken from the soonest-expiring bucket first (the monthly allowance), then from non-expiring credits oldest-first (daily allowance, purchases). You therefore never lose purchased credits to expiry while allowance credits sat unused. The daily sweep (00:05 UTC) writes an `expiry` row for every lapsed bucket; the balance the platform reports is always the **available** balance (lapsed credits are never spendable, even before the sweep has run).

### Allowances

- **Daily** — 50 credits on every plan (the `daily-free-credits` entitlement; platform default `CREDITS_DAILY_FREE`). The sweep tops the balance up **to** 50; a balance already at or above 50 receives nothing. The first run of the day also grants it lazily, so a cron hiccup never parks a user.
- **Monthly** — `monthlyCredits` of the plan (3,000 Pro, 25,000 Enterprise), granted the moment a paid checkout completes and at the start of every following _allowance month_ (anchored on the subscription start, not the calendar), expiring at the end of that month. Annual subscriptions receive twelve monthly grants.

```
GET /api/credits/balance                    → { balanceCredits }
GET /api/credits/ledger?period=YYYY-MM&kinds=purchase,consumption&page=&pageSize=
GET /api/credits/usage-summary[?groupBy=day|model|agent|work][&period=YYYY-MM|7d|30d]
```

All three are read-only and owner-scoped. Credits are **never written over public HTTP** — purchases arrive through the billing-provider webhook and consumption through the metering debit hook.

## The Billing page

**Settings → Billing** shows:

- your **current plan** and a credits-forward plan switcher,
- your **credits balance**,
- **invoice history**,
- the **credits ledger**, filterable by entry kind and paged.

The purchase, payment-method and auto-recharge surfaces are flag-gated behind `PAYMENTS_ENABLED` (default off) until a payment provider is wired in; with the flag off, the page shows a "coming soon" card in their place. Preset top-up amounts are $10 / $25 / $100 at 100 credits per dollar.

## The Usage & Credits page

**Settings → Usage & Credits** (`/settings/usage`) answers "where did the credits go?". **One reporting period drives the whole page** — the tiles and all four charts always describe the same window.

### Choosing the period

The controls at the top-right of the page offer three ways to set it:

- **7d** and **30d** — rolling windows.
- A **calendar month** picker (_Pick a month_), listing the last twelve months newest-first.
- The page defaults to the **current calendar month**.

A `?period=` query parameter is honoured server-side, so a link like `/settings/usage?period=2026-07` renders exactly the month it names. An unrecognised value falls back to the current month rather than blanking the page. Switching back to a period you already viewed is instant — each period's snapshot is cached client-side for the session.

### Period totals

| Tile            | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| Credits balance | Live available balance (not window-bound).                            |
| Credits used    | Credits debited by usage inside the window (expiries are not "used"). |
| Credits added   | Purchases + grants + daily-free inside the window.                    |
| Credits expired | Allowance credits that lapsed inside the window (shown when > 0).     |
| Month spend     | Metered provider spend in cents for the window.                       |
| Tasks completed | Count for the window.                                                 |
| Works active    | Count for the window.                                                 |
| Agent runs      | Count for the window.                                                 |

A line under the tiles names the period they describe, so a screenshot is never ambiguous about what it is showing.

### The four breakdowns

| Chart              | Breaks the window down by        |
| ------------------ | -------------------------------- |
| **Usage per day**  | Each day in the period.          |
| **Usage by model** | The AI models the spend went to. |
| **Usage by agent** | The Agents that spent it.        |
| **Usage by Work**  | The Works it was spent on.       |

Rows that cannot be attributed to a model, agent or Work are grouped under **Unattributed** rather than dropped, so the breakdowns still add up. A period with no activity says "No usage in this period." instead of drawing an empty chart, and if a panel fails to load the page says so rather than showing a misleading zero.

### Export CSV

**Export CSV** downloads every usage event in the currently selected period as a CSV file, via `GET /api/credits/usage/export?period=…`. The `period` sent is whatever the selector is set to, so the export and the charts always agree.

`period` accepts a calendar month (`YYYY-MM`, default the current month) or a rolling `7d` / `30d` everywhere it appears — page, API and export alike.

## Plan entitlements

Plans carry additive entitlement keys. A missing row always means "use the platform default", never an error:

| Key                   | Effect                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily-free-credits`  | Size of the daily free grant (every plan; default 50).                                                                                                                                                                                                                                                                                               |
| `max-concurrent-runs` | Concurrency ceiling folded into run admission (raise-only vs the org ceiling), dark behind `PLAN_CONCURRENCY_ENFORCEMENT` (default off).                                                                                                                                                                                                             |
| `works-limit`         | ⚠️ Declared but **not read by anything** — the live Works ceiling is `subscription_plans.maxWorks` (`UNLIMITED_WORKS = 2_147_483_647` sentinel, comparisons `activeScheduleCount >= plan.maxWorks`). Do **not** seed it, and never with `-1`: a future reader wired against `-1` would refuse every schedule on exactly the tiers sold as unlimited. |
| `credit-limited`      | Whether the plan's runs are billed against the balance.                                                                                                                                                                                                                                                                                              |

Credit enforcement is deliberately conservative: only a `credit-limited` plan with a balance at or below zero parks new runs, and only when `CREDITS_ENFORCEMENT=on`. Today no plan seeds that row, so enforcement stays dark and a zero balance never blocks work unexpectedly.

## Related

- [Budgets & Usage](./budgets-and-usage.md) · [Sessions & Steering](./sessions-and-steering.md)
