---
id: subscription-billing
title: Subscription & Billing System
sidebar_position: 4
---

# Subscription & Billing System

How Ever Works charges for itself, end to end. The behaviour spec is
[`docs/specs/features/billing/spec.md`](../specs/features/billing/spec.md); the
implementation lives in `packages/agent/src/subscriptions/` and
`apps/api/src/billing/`. Everything sells through the shared "Ever Tech" Stripe
account under the `ever_works_*` lookup-key convention
(`packages/agent/src/subscriptions/billing/stripe-catalog.data.json`, applied by
`scripts/stripe-sync-catalog.mjs` — see the
[billing operations runbook](../runbooks/BILLING_STRIPE_OPERATIONS.md)).

## The three things Ever Works sells

| What        | Shape                                                                                                                                                                                                                                                                                                            | Where priced                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Plans**   | Free / Pro $25 / Enterprise $199 per month on cloud (annual $204 / $1,668); self-hosted Pro $49/mo, $408/yr or a $99 one-time perpetual licence; Enterprise Edition $199/mo                                                                                                                                      | catalog + `subscription_plans` seed            |
| **Seats**   | 10 included on paid tiers; +$5 (Pro) / +$10 (Enterprise) per additional seat per month. A seat is an employee OR an agent                                                                                                                                                                                        | catalog seat prices                            |
| **Credits** | 1 credit = 1¢ of platform-billed AI usage. Daily allowance 50 on every plan; monthly allowance 3,000 (Pro) / 25,000 (Enterprise) expiring at each allowance-month end; prepaid packs $10/1,000 · $50/5,500 · $200/25,000 (never expire); pay-as-you-go beyond the balance, opt-in, metered and billed in arrears | `credit-packs.ts` + the catalog `payg` section |

Plan codes are identities (`free` / `standard` / `premium`) and never change;
`standard` is displayed as "Pro" and `premium` as "Enterprise".

## Credits pipeline

1. **Metering** — every AI call lands in `plugin_usage_events` with `costCents`
   at provider list price (`AiFacade.calculateCost`).
2. **Settlement** — when a run reaches a terminal state,
   `RunCostSettlementService` sums the run's billable spend (BYOK-exempt
   plugins removed), stamps `agent_runs.costCents`, and converts the billable
   part to credits: `ceil(costCents × (CREDITS_PER_DOLLAR/100) × (1 + margin))`.
   The margin defaults to the catalog's `creditsMarginPercent` (35).
3. **Ledger** — one `consumption` row per run (`run:{runId}`), allocated
   against credit _buckets_ soonest-expiring first. Balance =
   available sum of the ledger; see
   [Credits & Billing](../features/credits-and-billing.md).
4. **Overflow** — if the balance cannot cover the debit and pay-as-you-go is
   on, the remainder (up to the monthly cap headroom) becomes a
   `credit_meter_events` row and a Stripe meter event; Stripe rates it under
   the graduated metered price and invoices in arrears.
5. **Enforcement** — the dispatch gate parks new runs for credit-limited plans
   with no balance and no pay-as-you-go headroom (`CREDITS_ENFORCEMENT`
   defaults on iff Stripe is configured).

## Seats

A seat is an **employee OR an agent** — interchangeable, which is the point of
the product. Paid plans include 10; extras are billed per seat per month from
the catalog ($5 Pro / $10 Enterprise).

- **Counted tenant-wide.** Access in Ever Works is tenant-wide, so somebody
  who belongs to three Organizations in one Tenant occupies ONE seat, and an
  agent built by a team member is capacity exactly like one the owner built.
  Archiving an agent frees its seat.
- **Persisted from the provider.** `user_subscriptions.seats` /
  `providerSeatItemId` are reconciled from the subscription's items on every
  `subscription.*` delivery (the seat item is the one whose price
  `lookup_key` carries the `_seat_` infix), never guessed locally. NULL means
  "fall back to the plan's `seatsIncluded`" — never zero, which would read as
  "no seats allowed".
- **Enforced before the write.** Inviting a member (at invite AND at accept)
  and creating an agent ask `SeatsService.assertSeatAvailable` for the Tenant
  owner first; a full allowance surfaces as **402** with the counts. The check
  fails OPEN on everything else: subscriptions disabled, an unbounded plan, or
  any resolution error never blocks adding a teammate.
- **Adjustable.** `POST /api/billing/seats` takes the TOTAL wanted (a total,
  not a delta — a delta double-charges on a retry); the server bills
  `max(0, total − included)` from the stored plan row and refuses to drop the
  allowance below what is already in use.

## Stripe integration (the provider seam)

`BillingProvider` is the vendor-neutral seam; `StripeBillingProvider` is the
only file that imports the Stripe SDK. It uses:

- **Checkout Sessions** — `mode: payment` for credit packs and the perpetual
  licence, `mode: subscription` for plans (+ seat line items), `mode: setup`
  for card capture. Every session that CHARGES carries Stripe Tax
  (`automatic_tax` + `customer_update` + `tax_id_collection`); `mode: setup`
  deliberately does not, because saving a card charges nothing. The
  pay-as-you-go subscription carries `automatic_tax` too.
- **PaymentIntents (off-session)** — threshold auto-recharge.
- **Subscriptions** — plans, and one usage-only subscription per owner for
  pay-as-you-go (`billing_thresholds.amount_gte = $50` for mid-cycle
  invoicing; cancelled immediately with `invoice_now` on disable).
- **Billing Meters** — `ever_works_credits`, aggregation `sum` by
  `stripe_customer_id`; meter events are keyed `run:{runId}` (identifier =
  request idempotency key), retried by the `credits-meter-flush` cron and
  given up after 23 hours for manual reconciliation. This stays inside
  Stripe's 24-hour idempotency window and prevents a late retry from
  double-counting usage after the request key expires.
- **Webhooks** — signature-verified, normalized to a closed event union;
  every ledger write is idempotent on the provider event id. The
  pay-as-you-go subscription's lifecycle normalizes to `payg.updated` and can
  never move a plan tier; its invoices are tagged `subscriptionKind: 'payg'`
  so a payment failure suspends overflow and a payment resumes it.
- **Customer Portal** — the past-due recovery surface.

## Scheduled jobs

| Task                  | Cadence     | Does                                                                            |
| --------------------- | ----------- | ------------------------------------------------------------------------------- |
| `credits-daily-grant` | 00:05 UTC   | expire lapsed buckets → daily allowance top-ups → monthly plan-allowance grants |
| `credits-meter-flush` | every 5 min | resend meter events the settlement path could not deliver                       |

## Legacy: per-run pay-per-use (deprecated)

The 2026-05 design (`WorkScheduleService` `billingMode=usage`,
`UsageLedgerService.recordUsage`, `PAY_PER_USE_PRICE_USD`,
`BillingProvider.recordUsageCharge`) predates credits. `recordUsageCharge` is
a no-op on every provider and `overagePricePerRun` is never billed — the path
only writes `usage_ledger_entries` rows in `pending`. It is superseded by
credits + pay-as-you-go, kept only until its removal is confirmed, and must
not be extended.

## Configuration

| Env                                                                    | Meaning                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `SUBSCRIPTIONS_ENABLED`                                                | master switch for plan resolution/gating (default off)                |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`                          | the money path; both blank = manual provider, everything fails closed |
| `PAYMENTS_ENABLED` (web)                                               | shows the live purchase surfaces instead of coming-soon               |
| `CREDITS_ENFORCEMENT`                                                  | on/off; unset = on iff Stripe is configured                           |
| `CREDITS_PER_DOLLAR` / `CREDITS_MARGIN_PERCENT` / `CREDITS_DAILY_FREE` | conversion knobs; margin defaults to the catalog (35)                 |
| `PAYG_MAX_MONTHLY_CAP_CREDITS`                                         | ceiling for a self-service pay-as-you-go cap                          |
