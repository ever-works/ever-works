# @ever-works/stripe-metrics-plugin

Read-only Stripe business metrics for the Ever Works **Goals** feature
(capability: `metrics-provider`). Lets Goals evaluate targets like
"$100/day balance" or "$1000/month income" without hard-coding Stripe
anywhere in the platform.

Built on the **official [`stripe`](https://www.npmjs.com/package/stripe)
Node SDK** (no hand-rolled REST).

## Metrics

| Metric id           | What it reads                                          | Windows                  | Unit                             |
| ------------------- | ------------------------------------------------------ | ------------------------ | -------------------------------- |
| `balance_available` | Current available balance (`stripe.balance.retrieve`)  | `point`                  | configured currency (e.g. `usd`) |
| `gross_volume`      | Sum of successful (paid) charges (`stripe.charges.list`) | `day`, `week`, `month` | configured currency              |

Notes:

- All window boundaries are computed in **UTC**. `week` is the ISO week
  (Monday 00:00:00 UTC through the following Monday). `windowAnchor`
  (ISO-8601) selects "the day/week/month containing this instant";
  omitted = now.
- Stripe amounts are minor units; values are converted with `amount / 100`.
  Two-decimal currencies (usd, eur, gbp, ...) are assumed — zero-decimal
  currencies (jpy, krw, ...) are not yet compensated for.
- `gross_volume` is **single-currency**: it counts **paid** charges in the
  configured `currency` only — charges in any other currency are excluded
  from the sum (multi-currency accounts get the configured-currency slice,
  not a mixed-denomination total). Refunds are *not* subtracted (that is
  what makes it gross).
- Because `charges.list` has no server-side currency filter, excluded
  foreign-currency charges are still walked and **count toward the
  pagination cap** below.

### Pagination cap (`metric-truncated`)

`gross_volume` walks charges with the SDK's auto-pagination
(`autoPagingEach`, 100 charges/page). Very large accounts may be slow —
one network round-trip per page — so reads are capped at **20 pages
(2,000 charges) per window**. Past the cap the plugin throws a typed
`MetricTruncatedError` (`code: 'metric-truncated'`) instead of silently
undercounting. If you hit it, narrow the window (e.g. evaluate per day
instead of per month).

### Why no `net_income`?

Real net income requires walking **balance transactions**
(`balanceTransactions.list`) and summing `net` across many transaction
types (charges, refunds, fees, payouts, disputes, adjustments) with
per-type sign conventions and currency-conversion edge cases. That is a
project of its own; the metric id `net_income` is **reserved** in
`STRIPE_METRIC_IDS` so nothing else squats on it, and `gross_volume` is
the documented income approximation until it lands.

## Read-only by design — use a restricted key

This plugin never writes to your Stripe account (the `metrics-provider`
contract forbids it). Don't hand it more power than it needs: use a
**restricted API key** instead of your full secret key.

1. Open [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)
2. Click **Create restricted key**
3. Grant only **Balance: Read** and **Charges: Read**
4. Use the resulting `rk_...` key as the plugin's secret key

## Settings

| Setting     | Required | Description                                                                                  |
| ----------- | -------- | -------------------------------------------------------------------------------------------- |
| `secretKey` | yes      | Stripe secret key (`rk_...` recommended). Secret; env fallback: `STRIPE_SECRET_KEY`.          |
| `currency`  | no       | Lowercase ISO-4217 code metric values are reported in. Default `usd`.                         |

## Development

```bash
pnpm build   # tsc --noEmit && tsup (ESM + CJS + d.ts)
pnpm test    # Vitest (SDK fully mocked — no network)
```
