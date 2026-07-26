---
id: credits-and-billing
title: Credits & Billing
sidebar_label: Credits & Billing
---

# Credits & Billing

**Credits** are the platform's unit of consumption. Agent runs, pipelines and AI calls debit them; grants, plan inclusions and (once payments are wired) purchases add them. Two settings pages read this data: **Billing** for the plan, the balance and the ledger, and **Usage & Credits** for where the money went.

Credits are complementary to [Budgets](./budgets-and-usage.md), not a replacement: budgets cap _spend at a scope before a call runs_; credits are the account-level balance the platform meters against.

## The ledger is the source of truth

There is no separate balance column. Your balance is the **sum of your ledger movements**, so the number and its explanation can never disagree.

| Entry kind    | Sign | What it is                                                   |
| ------------- | ---- | ------------------------------------------------------------ |
| `purchase`    | +    | A top-up or auto-recharge confirmed by the billing provider. |
| `grant`       | +    | Plan-included, promotional or admin grant.                   |
| `daily-free`  | +    | The small daily allowance granted by a scheduled job.        |
| `consumption` | −    | Metered usage, rolled up per run / Task.                     |
| `adjustment`  | ±    | Platform correction.                                         |
| `expiry`      | −    | Expiring promotional or daily grants, where configured.      |

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

**Settings → Usage** shows the period totals and four spend breakdowns:

| Tile            | Meaning                                            |
| --------------- | -------------------------------------------------- |
| Balance         | Live balance (not window-bound).                   |
| Consumed        | Credits debited inside the window.                 |
| Added           | Purchases + grants + daily-free inside the window. |
| Spend           | Metered provider spend in cents for the window.    |
| Tasks completed | Count for the window.                              |
| Works active    | Count for the window.                              |
| Agent runs      | Count for the window.                              |

Charts break the same window down **per day** (with a 7d / 30d toggle), **per model**, **per agent** and **per Work**. `period` accepts a calendar month (`YYYY-MM`, default the current month) or a rolling `7d` / `30d`.

## Plan entitlements

Plans carry additive entitlement keys. A missing row always means "use the platform default", never an error:

| Key                   | Effect                                                  |
| --------------------- | ------------------------------------------------------- |
| `daily-free-credits`  | Size of the daily free grant.                           |
| `max-concurrent-runs` | Concurrency ceiling consulted by the run dispatch gate. |
| `works-limit`         | How many Works the plan allows.                         |
| `credit-limited`      | Whether the plan's runs are billed against the balance. |

Credit enforcement is deliberately conservative: only a `credit-limited` plan with a balance at or below zero parks new runs, and only when `CREDITS_ENFORCEMENT=on`. Today no plan seeds that row, so enforcement stays dark and a zero balance never blocks work unexpectedly.

## Related

- [Budgets & Usage](./budgets-and-usage.md) · [Sessions & Steering](./sessions-and-steering.md)
