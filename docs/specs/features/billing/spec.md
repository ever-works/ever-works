# Feature Specification: Billing — Credits, Plans, Seats and Pay-as-you-go

> Behaviour-first spec. This document is the **recovered billing PRD** for the Ever Works
> platform (the 2026-07-25 "billing/usage PRD" that PRs #1839 / #1845 / #1849 / #1900 cite by
> section number is not on disk; this file re-states everything that shipped from it and adds the
> 2026-08 decisions). Implementation notes live in [`plan.md`](./plan.md).

**Feature ID**: `billing`
**Branch**: `feat/billing-payg-metered`
**Status**: `Active` (Wave 9 M1/M2 + Wave 13 + B5/B07/B08/B24 shipped; PAYG + grants + seats in this branch)
**Created**: 2026-08-23
**Last updated**: 2026-08-23
**Owner**: Ever Works Team
**Supersedes**: the prepaid-only reading of `docs/specs/features/subscriptions/spec.md` (2026-05, `Retrospective`) and the "usage-based billing" section of `docs/advanced/subscription-billing.md`.

---

## 1. Overview

Ever Works sells **three things** on one shared Stripe account ("Ever Tech", `acct_1IDnd6DdBrwbGEir`):

1. **A plan** — Free / Pro / Enterprise (cloud) or Community / Pro / Enterprise Edition (self-hosted). Flat, recurring (monthly/annual) or a one-off perpetual licence on self-hosted Pro.
2. **Seats** — employees **or** agents, interchangeable. Each paid plan includes 10; additional seats are a per-unit recurring price ($5 Pro / $10 Enterprise per seat per month).
3. **Credits** — the unit of platform-billed AI usage. **1 credit = 1 cent** of platform-billed usage. Credits come from four places, all landing in one append-only ledger:
    - the **daily free allowance** (50/day, every plan; one grant per user per UTC day),
    - the **monthly plan allowance** (3,000 Pro / 25,000 Enterprise, expiring at the end of each allowance month),
    - **prepaid packs** ($10/1,000 · $50/5,500 · $200/25,000, never expire) — bought at checkout or by threshold auto-recharge,
    - **pay-as-you-go (PAYG)** — when the prepaid balance is exhausted and the owner has opted in, the remainder is **metered to Stripe and invoiced monthly in arrears** at graduated per-credit rates, under a user-set monthly cap.

Runs on the customer's **own model keys** (BYOK/BYOS) spend no credits on any plan.

This spec closes the five gaps found in the 2026-08-23 audit:

| Gap | What was wrong                                                                                                                                      | What this spec does                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Paid subscribers received **zero** credits (no monthly grant writer; daily grant was free-plan-only in code while catalog/marketing said universal) | §3.2 monthly allowance grants + expiry; §3.1 universal daily grant                                                                           |
| 2   | `CREDITS_MARGIN_PERCENT=0` → packs sold at or below provider list cost                                                                              | §3.4 margin becomes a catalog value (35 %) with documented economics                                                                         |
| 3   | Seats billed to Stripe but neither persisted nor enforced; ledger per user                                                                          | §3.6 seats persisted, exposed, enforceable, adjustable; org wallets explicitly deferred (§7)                                                 |
| 4   | Docs drift (pack prices, plan names, removed Stripe APIs), ToS promises in-arrears invoicing the code could not do, PRD missing                     | this spec + `docs/features/credits-and-billing.md` + `docs/advanced/subscription-billing.md` rewritten; §3.5 makes in-arrears invoicing real |
| 5   | "Pay-as-you-go from your credits balance" on plan cards while no PAYG existed                                                                       | §3.5 real PAYG; plan-card wording changed to "Usage is billed from your credits balance"                                                     |

## 2. User Scenarios

### 2.1 Credits — allowances

- **Given** I am on any plan, **when** the daily sweep runs (00:05 UTC) or I dispatch my first run of the day, **then** I receive that plan's daily allowance (50) exactly once for that UTC day.
    - The grant carries **no balance ceiling** (decided in #2203): a ceiling had to be measured against the whole ledger sum — purchases included — so it silently denied the advertised daily credits to every paid tier and to any free user who had bought a pack. The `daily:{userId}:{date}` key is the only invariant that matters. Accepted consequence: an idle free account accrues without bound (see §6).
- **Given** I subscribe to Pro, **when** the checkout completes (webhook or return route), **then** 3,000 credits are granted immediately with an expiry at the end of my first allowance month, and a fresh 3,000 are granted at the start of every following allowance month while the subscription is active.
- **Given** I have 900 unused allowance credits when the allowance month ends, **when** the sweep runs, **then** a `−900 expiry` row is written and my balance drops by 900; purchased credits are untouched.
- **Given** I have allowance credits, daily credits and purchased credits, **when** a run is settled, **then** the debit is taken from the **soonest-expiring** credits first (allowance → daily/purchased in creation order), so I never lose purchased credits to expiry while allowance credits sat unused.
- **Given** I cancel Pro at period end, **when** the period ends, **then** no further monthly grants are written; already-granted allowance credits keep their original expiry.

### 2.2 Credits — prepaid packs and auto-recharge (unchanged behaviour, restated)

- **Given** payments are enabled and Stripe is configured, **when** I buy a pack, **then** the ledger is credited **only** by the signature-verified webhook with the server pack's credits; the client never sends an amount.
- **Given** auto-recharge is on with threshold T and pack P, **when** a debit takes my balance below T, **then** exactly one off-session charge for P is placed per crossing; credits arrive via the webhook.

### 2.3 Pay-as-you-go (new)

- **Given** I have a stored payment method, **when** I enable Pay-as-you-go and set a monthly cap (default 10,000 credits), **then** a metered Stripe subscription (no flat fee) is created for my customer with the PAYG price and a $50 billing threshold, and the Billing page shows "Pay-as-you-go: on · this cycle 0 credits · cap 10,000".
- **Given** PAYG is on and my prepaid balance is 120 credits, **when** a run costs 500 credits, **then** 120 credits are debited from the ledger (balance → 0) and **380 credits are reported to the Stripe meter**; the run completes normally.
- **Given** PAYG is on, **when** my cycle usage reaches 80 % of the cap, **then** I receive a notification; **when** it reaches the cap, **then** new runs are parked with `queuedReason=insufficient-credits` until I raise the cap, buy a pack, or the cycle rolls.
- **Given** PAYG accrual in the cycle reaches $50, **when** Stripe evaluates the threshold, **then** Stripe issues and charges an invoice for the accrued usage mid-cycle (exposure control); **at period end** the remainder is invoiced. Invoices appear in my invoice history.
- **Given** a PAYG invoice payment fails, **when** the webhook arrives, **then** PAYG is marked `past_due`, no further overflow is metered, runs that need overflow are parked, and the Billing page shows the past-due banner with the portal link. **When** the invoice is later paid, **then** PAYG resumes automatically.
- **Given** PAYG is on, **when** I disable it, **then** the Stripe subscription is cancelled **immediately with `invoice_now`** (accrued usage is invoiced at once — nothing is prepaid, so there is nothing to keep serving) and overflow stops at once.
- **Given** PAYG graduated rates, **when** I use 30,000 credits in one cycle, **then** I am billed 5,000 × 1.00¢ + 20,000 × 0.91¢ + 5,000 × 0.80¢ = $50 + $182 + $40 = $272 (before tax).

### 2.4 Enforcement

- **Given** Stripe is configured (`STRIPE_SECRET_KEY` set) and `CREDITS_ENFORCEMENT` is unset, **when** a credit-limited user with balance 0 and no PAYG headroom dispatches a run, **then** the run is parked (`insufficient-credits`); a user with balance > 0 **or** PAYG headroom > 0 is admitted.
- **Given** Stripe is **not** configured and `CREDITS_ENFORCEMENT` is unset (self-hosted, dev, CI), **when** any user dispatches a run, **then** no credits gate applies — exactly today's behaviour.
- **Given** a run was admitted and then overshoots the balance/cap mid-run, **when** it settles, **then** the part that fits is debited/metered and the remainder is **written off** (recorded on the meter-event row as `writtenOffCredits`, never billed) — the platform never bills beyond the cap it promised.

### 2.5 Seats

- **Given** I am on Pro (10 seats included) with no extra seats, **when** my organisation has 10 members+agents and I invite an 11th, **then** the invite is refused with a "seat limit" error that links to the Billing page.
- **Given** I buy 3 additional seats on the Billing page, **when** the Stripe subscription item quantity is updated (prorated), **then** my allowance becomes 13 and the invite succeeds.
- **Given** subscriptions are disabled on the deployment, **when** anyone invites members or creates agents, **then** no seat gate applies.

### 2.6 Edge cases & failures

- A webhook replay (same Stripe event id) moves the ledger zero times and creates zero meter events.
- A meter event that fails to send (Stripe outage) is retried by the flush job every 5 minutes; events older than 23 hours are marked `failed` and logged for manual reconciliation — never silently dropped. This cutoff stays inside Stripe's 24-hour idempotency window and prevents a late retry from double-counting usage.
- The credits gate is **fail-open**: any exception in the precheck admits the run and logs.
- The ledger never records negative balances from consumption; refund reversals remain the only allowed negative-balance write.
- A self-hosted licence purchase grants neither a cloud tier nor credits (unchanged).

## 3. Functional Requirements

### 3.1 Daily free allowance (universal)

- **FR-1** The daily sweep MUST apply the `daily-free-credits` entitlement to **every** plan code; the platform fallback (`CREDITS_DAILY_FREE`, default 50) applies to any plan without a row. The free/standard/premium rows are seeded at 50.
- **FR-2** The grant MUST be exactly-once per user per UTC day (`daily:{userId}:{date}`) and MUST NOT apply a balance ceiling — a ceiling measured against the ledger sum denies the allowance to anyone holding purchased credits.
- **FR-3** The dispatch gate MUST lazily grant today's daily allowance before evaluating the balance, so a deployment whose cron has not run today never parks a user who is owed free credits.

### 3.2 Monthly plan allowance + expiry

- **FR-4** On plan activation (webhook **and** return route, both idempotent) the system MUST grant `subscription_plans.monthlyCredits` for the current allowance month with idempotency `grant:plan:{userId}:{allowanceMonthStart}` and `expiresAt = allowanceMonthEnd`.
- **FR-5** A daily sweep MUST grant the current allowance month for every **active** cloud subscription that has not received it yet (anchor = `user_subscriptions.createdAt` day-of-month, month arithmetic clamped to month end). Annual subscriptions therefore receive 12 monthly grants, not 12 months at once.
- **FR-6** Positive ledger rows MUST carry `remainingCredits` and optional `expiresAt`; debits MUST be allocated against buckets ordered by `expiresAt ASC NULLS LAST, createdAt ASC` inside the same transaction as the debit.
- **FR-7** The sweep MUST write an `expiry` row of `−remainingCredits` (idempotency `expiry:{entryId}`) for every bucket whose `expiresAt ≤ now` and `remainingCredits > 0`, and zero the bucket. Settlement MUST expire the debiting user's due buckets first ("expire on touch").
- **FR-8** `getBalance` MUST return the **available** balance: `SUM(amountCredits) − SUM(remainingCredits WHERE expiresAt ≤ now)`.
- **FR-9** Purchased credits (`purchase`) and refund adjustments MUST never carry an expiry.

### 3.3 Prepaid packs (restated, unchanged)

- **FR-10** Checkout takes a pack id only; prices/credits come from `credit-packs.ts`; the webhook credits the ledger.

### 3.4 Margin and unit economics

- **FR-11** `creditsMarginPercent` MUST be a catalog value (`stripe-catalog.data.json`) used as the default for `CREDITS_MARGIN_PERCENT`; an explicit env var still overrides (self-hosters).
- **FR-12** The catalog value is **35**. Rationale: metered cost is OpenRouter list price (+5.5 % OpenRouter purchase fee) and Stripe takes ~2.9 % + 30¢; at 35 % the $200/25,000 pack is at break-even, the $50/5,500 pack nets ≈ +11 %, the $10/1,000 pack ≈ +17 %, and PAYG base tier ≈ +22 %. Owner may retune by editing one JSON value; the unit test pins the table.
- **FR-13** The Usage & Credits page MUST state the conversion ("1 credit = 1¢ of platform-billed usage; platform rate includes a 35 % service margin over provider list price") so the number is never a surprise.

### 3.5 Pay-as-you-go (Stripe Billing Meters)

- **FR-14** The catalog MUST declare a PAYG section: meter event name `ever_works_credits`, product, price `lookup_key = ever_works_payg_credits_monthly`, `usage_type=metered`, `billing_scheme=tiered`, `tiers_mode=graduated`, tiers `≤5,000 @ 1.00¢`, `≤25,000 @ 0.91¢`, `∞ @ 0.80¢` (`unit_amount_decimal`, cents), `invoiceThresholdCents = 5000`, `defaultMonthlyCapCredits = 10000`, `maxMonthlyCapCredits = 100000` (raise via `PAYG_MAX_MONTHLY_CAP_CREDITS`).
- **FR-15** `scripts/stripe-sync-catalog.mjs` MUST create/verify the Billing Meter (matched by `event_name`; meters are never deleted, only deactivated) and the metered price (matched by `lookup_key`; tier changes supersede the price exactly like flat prices). `--verify` MUST report meter/price drift.
- **FR-16** Enabling PAYG MUST require a stored default payment method and MUST create one metered Stripe subscription per billing profile: `items=[{price: payg}]`, `collection_method=charge_automatically`, `default_payment_method`, `billing_thresholds={amount_gte: 5000, reset_billing_cycle_anchor:false}`, metadata `ever_works_kind=payg-subscription` + `ever_works_user_id`. The profile persists `paygSubscriptionId`, `paygSubscriptionItemId`, `paygStatus`, `paygPeriodStart/End`, `paygMonthlyCapCredits`, `paygEnabled`.
- **FR-17** Disabling PAYG MUST cancel the metered subscription immediately with `invoice_now=true, prorate=false` and set `paygEnabled=false` before the provider call returns (overflow stops even if the provider call fails; the failure is surfaced).
- **FR-18** Settlement MUST, after the prepaid debit, route the remainder to PAYG when `paygEnabled && paygStatus ∈ {active, trialing}`: `bill = min(remainder, cap − cycleUsed)`; one row in `credit_meter_events` (`userId, runId, credits=bill, writtenOffCredits=remainder−bill, costCentsRef, periodStart, periodEnd, status`), unique on `identifier = run:{runId}`; then one Stripe meter event `{event_name, payload:{stripe_customer_id, value}, identifier, timestamp}`. Row first, send second, send failures retried by the flush job.
- **FR-19** `cycleUsed` MUST be computed locally from `credit_meter_events` in `[paygPeriodStart, paygPeriodEnd)`; the dispatch gate MUST admit when `balance > 0 || (payg active && cycleUsed < cap)`.
- **FR-20** Notifications MUST fire at 80 % and 100 % of the cap (once per cycle each).
- **FR-21** Webhooks: `customer.subscription.*` with kind `payg-subscription` → `payg.updated` (status/period reconcile, never touches the plan tier); `invoice.payment_failed` whose subscription is the PAYG one → `paygStatus=past_due` + notification; `invoice.paid` on it → `paygStatus=active`; all invoices keep being mirrored.
- **FR-22** Every provider session that CHARGES (credit pack, plan, licence) and the PAYG subscription MUST carry Stripe Tax. On hosted checkout that means `automatic_tax` + `customer_update: {address:'auto', name:'auto'}` + `tax_id_collection`; on the PAYG subscription only `automatic_tax` (the other two are Checkout-only and Stripe rejects them). `mode: 'setup'` sessions MUST NOT ask for tax — saving a card charges nothing. No env flag: the shared account has Stripe Tax active with live registrations.
- **FR-23** A Trigger.dev task `credits-meter-flush` (every 5 min) MUST resend `pending` meter events less than 23 hours old, mark older rows `failed` for manual reconciliation, and a daily task MUST run expiries, daily grants and plan grants (extend `credits-daily-grant`). The retry cutoff MUST remain inside Stripe's 24-hour request-idempotency window.
- **FR-24** The Billing page MUST show a PAYG card: toggle, cap input, this-cycle credits + estimated amount (computed from the catalog tiers), status chip (on/off/past due), next invoice date, explanatory copy with the tier table; the Usage page MUST show "Pay-as-you-go this cycle" in the tiles.
- **FR-25** The legacy per-run `billingMode=usage` path (`UsageLedgerService`, `PAY_PER_USE_PRICE_USD`, `recordUsageCharge`) is **deprecated** by this spec, left in place (removal needs owner confirmation — tracked in Jira), and documented as dead.

### 3.6 Seats

- **FR-26** `user_subscriptions.seats` MUST persist the total seats on the Stripe subscription (included + additional), reconciled from the subscription's items on every `subscription.*` webhook and set from the checkout request.
- **FR-27** `SeatsService` MUST expose `{ included, purchased, allowance, used }` for an owner where `used = distinct members of organisations the owner owns + active agents the owner owns`; `allowance = null` means unbounded.
- **FR-28** Organisation member admission and agent creation MUST refuse when `used ≥ allowance` (mapped to HTTP 402 `seat-limit`), **only** when subscriptions are enabled; otherwise fail-open.
- **FR-29** `POST /api/billing/seats {seats}` MUST update the Stripe seat item quantity (creating the item from the catalog seat price if absent) with default proration and persist the new total.

### 3.7 Enforcement defaults

- **FR-30** `CREDITS_ENFORCEMENT` unset MUST resolve to **on** when the billing provider is configured and **off** otherwise; explicit `on|off` still wins. `credit-limited=1` is seeded for `free`, `standard`, `premium`; self-hosted plan codes carry no row (never limited).

### 3.8 Surfaces

- **FR-31** API: `GET /api/billing/payg`, `PUT /api/billing/payg {enabled, monthlyCapCredits}`, `GET /api/billing/seats`, `POST /api/billing/seats`, overview carries `payg` + `seats`, plan summary carries seats. Owner-scoped; money routes 503 when the provider is not configured.
- **FR-32** Docs: `docs/features/credits-and-billing.md`, `docs/advanced/subscription-billing.md`, `docs/api/subscriptions.md`, `docs/agent-services/subscriptions-module.md` reconciled to this spec; `docs/runbooks/BILLING_STRIPE_OPERATIONS.md` added (catalog sync, enabling payments per environment, PAYG ops, reconciliation queries).

## 4. Non-goals (v1)

- Organisation-pooled wallets (one balance shared by an org). The ledger stays per user; the owner pays for their org's usage. Tracked as a follow-up because "who is the billing owner of an org" is a product decision.
- Stripe Billing Credits (credit grants) — they only apply at invoice finalisation and only to metered lines, so they cannot represent our real-time prepaid drawdown; our own ledger stays the source of truth. Revisit only if we move rating to Stripe/Metronome.
- Metronome. Stripe positions it as primary for new usage-based integrations, but it is a separate contract (0.8 % of volume), has limited Checkout support and no Dashboard support; Billing Meters remain fully supported and are Stripe's fit for pay-as-you-go. Revisit for enterprise commits/ramps.
- Removing the deprecated per-run pay-per-use code.

## 5. Success criteria

- A Pro subscriber's ledger shows `grant +3000` within seconds of checkout and `expiry` rows at month end; daily grants appear on paid plans.
- With PAYG on and balance 0, a run settles with a `credit_meter_events` row, a Stripe meter event visible in the Dashboard, and the mid-cycle/period-end invoice charged.
- `node scripts/stripe-sync-catalog.mjs --verify` reports 0 drift in test mode after sync (meter + 23 prices).
- Seat refusal path and seat purchase path covered by API specs; margin table pinned by unit test; all existing billing specs green.

## 6. Open questions (owner)

- **Bounding daily-allowance accrual — now possible, deliberately not done here.** The daily grant is
  unbounded (FR-2), so an idle free account accrues 50/day forever (~$182 of platform AI per year).
  #2203 correctly noted that "capping accrual needs lot tracking and expiry, not a ceiling — and this
  repo has no code that can remove a granted credit". §3.2 of this spec **added exactly that** (buckets
    - `expiry` rows), so the clean fix is now one line: give `daily-free` grants an `expiresAt` (e.g. end
      of the following UTC day), which bounds accrual at ~2 days of allowance without ever touching
      purchased credits. It is left OFF because how generous the free tier is, is a product decision, not a
      refactor — say the word and it is a one-value change plus a spec/doc line.
- Confirm 35 % margin and the PAYG tier rates (single JSON edit to change).
- Confirm cap defaults (10,000 default / 100,000 max).
- Live-mode catalog sync and prod env wiring (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENTS_ENABLED`, `SUBSCRIPTIONS_ENABLED`) are operator actions — see the runbook.

## 7. Follow-ups (ticketed)

- Org-pooled wallets / billing owner for organisations.
- Remove deprecated per-run pay-per-use path after confirmation.
- Marketing site: add the PAYG row and rates to `/pricing` (`ever-works/website`, `packages/web/libs/data/pricing-credits.ts`).
