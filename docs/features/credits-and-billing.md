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

The purchase, payment-method, auto-recharge and pay-as-you-go surfaces are gated behind `PAYMENTS_ENABLED` (default off) AND the provider actually being configured; with either off, the page shows a "coming soon" card in their place. The credit packs are **$10 / 1,000 · $50 / 5,500 · $200 / 25,000** — the server-side table in `credit-packs.ts` is the only source of prices, and checkout only ever accepts a pack id.

## Pay-as-you-go

When the prepaid balance cannot cover a run and the owner has **opted in**, the remainder is reported to a Stripe Billing Meter and invoiced **monthly in arrears** at graduated per-credit rates (1.00¢ up to 5,000 credits/cycle, 0.91¢ to 25,000, 0.80¢ beyond — packs always match or beat these, so prepaying stays the discount). The whole feature lives behind three rules:

- **Opt-in with a card.** Enabling requires a stored payment method; it creates a usage-only Stripe subscription (no flat fee) whose invoices charge that card, mid-cycle once accrued usage reaches $50 and at each cycle end.
- **A hard monthly cap.** Default 10,000 credits ($100), owner-adjustable up to the deployment ceiling. Usage beyond the cap is _written off, never billed_; new runs park at the cap until it is raised, a pack is bought, or the cycle resets. Notifications fire at 80 % and 100 %.
- **Dunning suspends, payment resumes.** A failed arrears invoice pauses pay-as-you-go (prepaid credits keep working) until it is settled from the Billing page's portal link.

Disabling cancels the usage subscription immediately and invoices what was consumed — nothing is prepaid, so nothing is kept running. `GET/PUT /api/billing/payg` is the API surface; the ledger is untouched by all of this (metered usage lives in `credit_meter_events`, mirrored to Stripe).

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

| Key                   | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily-free-credits`  | Size of the daily free grant (every plan; default 50).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `max-concurrent-runs` | Concurrency ceiling folded into run admission behind `PLAN_CONCURRENCY_ENFORCEMENT` (default off; **`on` in production since 2026-08-24**). Strictly **raise-only**: it is consulted only after the env valve has already decided to park a run, so it can exempt a run, never park one — which is why enabling it could not cut existing users from the env default to the `free` row's 3.                                                                                                                                                                                                                                                                                                                    |
| `works-limit`         | ⚠️ Declared but **not read by anything** — the live Works ceiling is `subscription_plans.maxWorks` (`UNLIMITED_WORKS = 2_147_483_647` sentinel, comparisons `activeScheduleCount >= plan.maxWorks`). It **is** already seeded — migration `1783400000000` writes `free = 1` (mirroring FREE `maxWorks`), and production confirms exactly that one row. Leave it at that: do not seed it for further plans, and **never with `-1`**. The Works domain's unlimited sentinel is `UNLIMITED_WORKS`, not `-1`, so a future reader wired against `-1` would read it as a ceiling of minus one and refuse every schedule creation — and pause every active schedule — on precisely the tiers advertised as unlimited. |
| `credit-limited`      | Whether the plan's runs are billed against the balance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Credit enforcement follows the money: `CREDITS_ENFORCEMENT` unset resolves to **on when the billing provider is configured** (`STRIPE_SECRET_KEY` present) and **off otherwise**, and `credit-limited = 1` is seeded for the three cloud tiers. The dispatch gate parks a run only when the plan is credit-limited, the available balance is ≤ 0 **and** there is no pay-as-you-go headroom — and it grants today's daily allowance lazily first, so a cron hiccup never blocks a user who is owed free credits. Self-hosted plan codes carry no `credit-limited` row and are never gated.

## Seats

Seats are a separate axis from credits: a seat is a person **or** an agent, and
the Billing page shows the allowance, what is using it, and the per-seat price.
See [Subscription & Billing](../advanced/subscription-billing.md#seats).

## Related

- [Budgets & Usage](./budgets-and-usage.md) · [Sessions & Steering](./sessions-and-steering.md)
