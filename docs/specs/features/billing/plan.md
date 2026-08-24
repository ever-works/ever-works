# Implementation Plan: Billing — Credits, Plans, Seats and Pay-as-you-go

> Companion to [`spec.md`](./spec.md). This is the **how**: data model, Stripe objects, service
> boundaries, file-level change list, PR sequencing and the test plan. Tasks are tracked in
> [`tasks.md`](./tasks.md).

**Feature ID**: `billing` · **Branch**: `feat/billing-payg-metered` · **Created**: 2026-08-23

---

## 0. Current state this plan builds on (verified 2026-08-23 on `develop` @ `2512abd10`)

| Layer | Exists today | File(s) |
| --- | --- | --- |
| Ledger | append-only `credit_ledger_entries`, SUM = balance, idempotent `recordAtomic` under a per-user row lock, floor/ceiling guards | `packages/agent/src/database/repositories/credit-ledger.repository.ts`, `entities/credit-ledger-entry.entity.ts` |
| Debit | `RunCostSettlementService.settleRun` → `CreditLedgerService.consumeForRun` (ceil(costCents × cpd/100 × (1+margin))), partial debit to 0 + notification on exhaustion, BYOK exemption | `subscriptions/credits/run-cost-settlement.service.ts`, `credit-ledger.service.ts` |
| Grants | daily free (Trigger cron `credits-daily-grant`, 00:05 UTC, free plan only) | `packages/tasks/src/tasks/trigger/credits-daily-grant.task.ts` |
| Money | `BillingProvider` seam + `StripeBillingProvider` (Checkout payment/subscription/setup, off-session PI, portal, webhooks: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`, `invoice.*`, `customer.subscription.*`, `payment_method.*`) | `subscriptions/billing/*.ts` |
| Catalog | `stripe-catalog.data.json` + `stripe-catalog.ts` + `scripts/stripe-sync-catalog.mjs` (22 flat prices on the shared account, lookup-key convention `ever_works_*`) | same dir + `scripts/` |
| API | `apps/api/src/billing/*` (overview, checkout, plan checkout, payment methods, subscription cancel/resume/portal, webhook) and `apps/api/src/subscriptions/*` (credits balance/ledger/usage, costs, plans) | |
| Web | `settings/billing` (BillingSettings.tsx + server actions in `app/actions/dashboard/billing.ts`), `settings/usage` | `apps/web/src/...` |
| Gate | `run-admission-chain.ts` credits step → `RunCostSettlementService.shouldQueueForCredits` (`CREDITS_ENFORCEMENT` + `credit-limited` entitlement + balance ≤ 0) | `packages/agent/src/agents/run-admission-chain.ts` |

Nothing metered, no `GRANT`/`EXPIRY` writers, no seats persistence, margin 0.

## 1. Data model changes (one migration per PR, TypeORM, sqlite+postgres)

### 1.1 `credit_ledger_entries` (PR-A)

| Column | Type | Notes |
| --- | --- | --- |
| `expiresAt` | timestamp NULL | set on `grant` (allowance month end); NULL on purchase/daily-free/adjustment |
| `remainingCredits` | int NULL | for positive rows: unconsumed part of this bucket; NULL on negative rows |

Indexes: `idx_credit_ledger_user_expires (userId, expiresAt)` (partial-ish: used by the expiry sweep and the available-balance query).
Backfill: `remainingCredits = amountCredits` for existing positive rows, then replay existing negative rows in `createdAt` order per user to allocate against buckets (done in the migration as a TypeScript loop — the table is small pre-launch; no SQL window tricks so sqlite and postgres behave the same).

### 1.2 `billing_profiles` (PR-C)

| Column | Type | Notes |
| --- | --- | --- |
| `paygEnabled` | bool default false | owner opted in |
| `paygSubscriptionId` | varchar(128) NULL | Stripe metered subscription |
| `paygSubscriptionItemId` | varchar(128) NULL | the metered item (for quantity/threshold updates) |
| `paygStatus` | varchar(32) NULL | `BillingSubscriptionStatus` |
| `paygPeriodStart` / `paygPeriodEnd` | timestamp NULL | current Stripe cycle, reconciled by webhook |
| `paygMonthlyCapCredits` | int NULL | user cap; default from catalog |
| `paygCapNotifiedPercent` | int default 0 | 0 / 80 / 100 — once-per-cycle notification latch, reset when period rolls |

### 1.3 `credit_meter_events` (new table, PR-C)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `userId`, `organizationId?`, `tenantId?` | uuid | scope (raw refs, EW-654 rule) |
| `runId` | uuid | `refId` |
| `identifier` | varchar(128) UNIQUE | `run:{runId}` — Stripe meter-event identifier and our idempotency key |
| `credits` | int | credits reported to the meter |
| `writtenOffCredits` | int default 0 | part beyond the cap that was not billed |
| `costCentsRef` | int NULL | metered provider cost this derived from |
| `periodStart` / `periodEnd` | timestamp | PAYG cycle at record time |
| `status` | varchar(16) | `pending` → `sent` / `failed` (terminal after 35 days) |
| `attempts` | int default 0 | |
| `lastError` | varchar(256) NULL | never the full provider error |
| `sentAt` | timestamp NULL | |
| `createdAt` | timestamp | |

Indexes: `(userId, periodStart)`, `(status, createdAt)`.

### 1.4 `user_subscriptions` (PR-D)

| Column | Type | Notes |
| --- | --- | --- |
| `seats` | int NULL | total seats (included + additional) on the provider subscription; NULL = unknown/unbounded |
| `providerSeatItemId` | varchar(128) NULL | Stripe subscription item for the seat price (NULL until first extra seat) |

### 1.5 `plan_entitlements` seeds (PR-A / PR-C)

- `daily-free-credits = 50` for `standard`, `premium` (free already has it).
- `credit-limited = 1` for `free`, `standard`, `premium`.

## 2. Catalog (`stripe-catalog.data.json` v2)

```jsonc
"version": 2,
"creditsMarginPercent": 35,
"payg": {
  "meterEventName": "ever_works_credits",
  "meterDisplayName": "Ever Works credits",
  "lookupKey": "ever_works_payg_credits_monthly",
  "productName": "Ever Works — Pay-as-you-go credits",
  "tiers": [
    { "upTo": 5000,  "centsPerCredit": "1" },
    { "upTo": 25000, "centsPerCredit": "0.91" },
    { "upTo": null,  "centsPerCredit": "0.8" }
  ],
  "invoiceThresholdCents": 5000,
  "defaultMonthlyCapCredits": 10000,
  "maxMonthlyCapCredits": 100000
}
```

`stripe-catalog.ts` gains `getCreditsMarginPercent()`, `getPaygCatalog()`, `estimatePaygCents(credits)` (graduated arithmetic, exported so API/UI use the same function) and `PAYG_LOOKUP_KEY`.

### Stripe objects created by `scripts/stripe-sync-catalog.mjs`

1. **Billing Meter** — `POST /v1/billing/meters` `{display_name, event_name, default_aggregation[formula]=sum, customer_mapping[event_payload_key]=stripe_customer_id, customer_mapping[type]=by_id, value_settings[event_payload_key]=value}`; matched on `event_name` among `status=active` meters; never deleted.
2. **Product** `ever_works_payg_credits` (metadata `ever_sku`, `ever_unit=credits`, `ever_billing=metered`).
3. **Price** `lookup_key=ever_works_payg_credits_monthly`: `currency=usd, recurring[interval]=month, recurring[usage_type]=metered, recurring[meter]={meter id}, billing_scheme=tiered, tiers_mode=graduated, tiers[i][up_to|inf], tiers[i][unit_amount_decimal]`. Drift = tier table or meter differs → new price + `transfer_lookup_key` + archive old (same as flat prices).

`--verify` covers the meter (exists, active, aggregation sum) and the price (tiers equal).

## 3. Service design

### 3.1 Ledger buckets + expiry (PR-A)

- `CreditLedgerRepository.recordAtomic`:
  - positive write → `remainingCredits = amount` (after ceiling clamp), `expiresAt = write.expiresAt ?? null`;
  - negative write → after floor check, allocate `|amount|` across buckets `WHERE userId AND remainingCredits > 0 AND (expiresAt IS NULL OR expiresAt > now) ORDER BY expiresAt ASC NULLS LAST, createdAt ASC` (driver-neutral: `ORDER BY CASE WHEN expiresAt IS NULL THEN 1 ELSE 0 END, expiresAt, createdAt`), decrementing each; unallocated remainder (only possible with `allowNegativeBalance`) is left unallocated.
  - new `expireDueBuckets(userId, now)`: in one transaction under the user lock, for each due bucket insert an `expiry` row (`idempotencyKey expiry:{entryId}`, `refType credit-ledger-entry`, `refId entryId`) and set `remainingCredits = 0`. Returns count + credits expired.
  - `getBalance(userId, now)` → available balance (FR-8). `getPeriodTotals` splits `consumedCredits` (kind consumption), `expiredCredits` (kind expiry), `addedCredits` (positive).
- `CreditLedgerService`:
  - `record` accepts `expiresAt`;
  - `expireDueCredits(userId?)` (one user, or all users with due buckets — repository method `findUsersWithDueBuckets(now, limit)`);
  - `dispatchDailyGrants`: fallback for every plan code (FR-1);
  - `grantForToday(userId)` lazy daily grant (FR-3) — same idempotency key as the sweep.
- New `PlanCreditGrantService` (`subscriptions/credits/plan-credit-grant.service.ts`):
  - `allowancePeriodFor(anchor: Date, now: Date) → {start, end}`, pure + unit-tested (month arithmetic clamped);
  - `grantCurrentAllowance(userId)` — resolves the active `user_subscriptions` row + plan (`monthlyCredits > 0`, hosting `cloud`, status `active|trialing`), writes `grant` with `expiresAt = end`, idempotency `grant:plan:{userId}:{startISODate}`;
  - `dispatchPlanGrants(now)` — batch over active subscriptions (new `UserSubscriptionRepository.findActiveBatch`).
- `PlanSubscriptionService.activate` → after the row write, `await planCreditGrantService.grantCurrentAllowance(userId)` (best-effort, logged).
- Trigger task `credits-daily-grant` → `expireDueCredits()` → `dispatchDailyGrants()` → `dispatchPlanGrants()`; RPC allow-list extended (`trigger-internal-api.client.ts`).

### 3.2 Margin (PR-B)

- `config.billing.credits.getMarginPercent()` → env if set, else `catalog.creditsMarginPercent`.
- `stripe-catalog.spec.ts` pins the economics table (FR-12) with a comment showing the arithmetic.
- Usage page copy (FR-13) via `GET /api/credits/pricing` (new, read-only: `{creditsPerDollar, marginPercent, packs, payg: {tiers, defaultCap, maxCap}}`) — one source for the UI.

### 3.3 PAYG (PR-C)

- **Seam additions** (`billing.provider.ts`): `createMeteredSubscription(req) → MeteredSubscriptionSnapshot`, `cancelMeteredSubscriptionNow(subscriptionId) → snapshot`, `reportMeterEvent({eventName, customerId, value, identifier, timestamp})`, `retrieveSubscriptionSnapshot(id)`; webhook kinds `payg.updated`, and `invoice.updated` gains `invoice.subscriptionId`, `invoice.subscriptionKind: 'plan'|'payg'|null`, `invoice.paymentFailed`.
- **Stripe provider**: metadata kind `payg-subscription`; `stripe.subscriptions.create({customer, items:[{price}], collection_method:'charge_automatically', default_payment_method, billing_thresholds:{amount_gte, reset_billing_cycle_anchor:false}, metadata, automatic_tax?})`; `stripe.billing.meterEvents.create({event_name, payload:{stripe_customer_id, value: String(credits)}, identifier, timestamp})` with `idempotencyKey = identifier`; `stripe.subscriptions.cancel(id, {invoice_now:true, prorate:false})`; normalization routes `customer.subscription.*` with kind `payg-subscription` → `payg.updated`; invoice events read `invoice.parent.subscription_details` (new API) falling back to `invoice.subscription` and the subscription metadata on the line's `parent.subscription_item_details` to stamp `subscriptionKind`.
- **`PaygService`** (`subscriptions/billing/payg.service.ts`): `getState(userId)`, `enable(userId, {monthlyCapCredits})`, `updateCap`, `disable`, `cycleUsage(userId)` (from `CreditMeterEventRepository.sumForPeriod`), `headroom(userId)`, `recordOverflow({...})` (row → send → mark), `applyWebhook(event)`, `flushPending(limit)`, `notifyIfThresholdCrossed`.
- **Settlement**: `settleInsufficient` → after partial debit, `paygService.recordOverflow` when eligible; `shouldQueueForCredits` → lazy daily grant; `balance > 0 || headroom > 0`.
- **Config**: `CREDITS_ENFORCEMENT` default-on-when-provider-configured; `PAYG_MAX_MONTHLY_CAP_CREDITS`. (Stripe Tax needs no flag — it landed unconditionally on every charging session in #2203.)
- **Trigger task** `credits-meter-flush` (`*/5 * * * *`) → `paygService.flushPending(500)`.
- **API** (`apps/api/src/billing/payg.controller.ts`): `GET /billing/payg`, `PUT /billing/payg` (DTO: `enabled: boolean`, `monthlyCapCredits?: int 100..max`, `forbidNonWhitelisted`), throttled like plan checkout. Overview gains `payg`.
- **Web**: server actions `updatePaygAction`; `BillingSettings` PAYG card; `billing.shared.ts` helpers (`canConfigurePayg`, `estimatePaygCents` re-export); Usage page tile; en.json keys under `dashboard.settings.billing.payg.*`; plan-card label change (`plans.paygFromBalance` → "Usage is billed from your credits balance").

### 3.4 Seats (PR-D)

- `SeatsService` (`subscriptions/billing/seats.service.ts`): allowance/usage/assert; repositories: `OrganizationMemberRepository.countDistinctMembersForOwner(userId)`, `AgentRepository.countActiveByUserId(userId)` (or reuse existing finders).
- Seam: `updateSeatQuantity({subscriptionId, seatLookupKey, quantity})` (find-or-create the seat item; `proration_behavior: 'create_prorations'`), `readSubscriptionSeats(subscription)` in normalization → `BillingSubscriptionSnapshot.seats` (sum of quantities of items whose price lookup_key matches `_seat_`) + `seatItemId`.
- `PlanSubscriptionService.activate/applyWebhook` persist `seats`/`providerSeatItemId`; `SubscriptionService.summarizePlan` exposes `{seatsIncluded, seatsPurchased, seatsUsed}`.
- Gates: `OrganizationMembershipService` (add/accept) and `AgentsService.create` call `seatsService.assertSeatAvailable(ownerUserId)`; `SeatLimitExceededError` → 402 filter (alongside `InsufficientCreditsError`).
- API: `GET /billing/seats`, `POST /billing/seats {seats}` (DTO int 0..1000). Web: seats row in the plan card with "Add seats" stepper.

### 3.5 Docs + ops (PR-E, may ride with PR-C)

- Rewrite `docs/features/credits-and-billing.md`, `docs/advanced/subscription-billing.md`; reconcile `docs/api/subscriptions.md`, `docs/agent-services/subscriptions-module.md`; mark `docs/specs/architecture/subscriptions.md` legacy sections; add `docs/runbooks/BILLING_STRIPE_OPERATIONS.md`; `.env.example` keys; `apps/docs/sidebarsPlatform.ts` entries.
- Workspace KB: `knowledge/infrastructure/EVER_WORKS_STRIPE_BILLING.md` (pointer + ops summary).

## 4. PR sequencing (all to `develop`, each self-contained + green)

| PR | Scope | Migration |
| --- | --- | --- |
| **A** `feat(billing): plan credit grants, expiring buckets, universal daily grant` | §3.1 | `AddCreditLedgerBuckets` + entitlement seeds |
| **B** `feat(billing): margin as a catalog value + pricing endpoint` | §3.2 | — |
| **C** `feat(billing): pay-as-you-go metered billing on Stripe Billing Meters` | §3.3 + enforcement default + docs/runbook + Trigger tasks | `AddPaygAndMeterEvents` + `credit-limited` seeds |
| **D** `feat(billing): seats persisted, enforced and adjustable` | §3.4 | `AddSubscriptionSeats` |
| **E** `docs(billing): reconcile billing docs, runbook` (folded into C/D if small) | §3.5 | — |

A and B are independent; C depends on A (buckets) and B (pricing endpoint); D is independent of C. Website `/pricing` PAYG row is a separate PR in `ever-works/website` after C merges.

## 5. Test plan

- **Unit (Jest, `packages/agent`)**: bucket allocation order; expiry sweep idempotency; available-balance math; allowance-period arithmetic (Jan 31 → Feb 28/29, anchor day clamping, DST-free UTC); margin table; `estimatePaygCents` tiers; `PaygService.recordOverflow` cap/written-off maths + idempotency + send-failure → pending; `flushPending` 35-day terminal; webhook normalization for `payg-subscription` and PAYG invoices; seats math and assert; provider calls shaped correctly (fake Stripe client via `STRIPE_CLIENT_FACTORY`).
- **API (Jest, `apps/api`)**: `PUT /billing/payg` DTO guards (extra fields rejected, cap bounds, no payment method → 409), `GET /billing/payg`, seats endpoints, 402 mapping for seat limit; webhook controller routes `payg.updated`.
- **Integration (sqlite)**: settlement end-to-end: balance 120 + run 500 → ledger −120, meter row 380 `pending/sent`; cap 1000 with 900 used + run 500 → row credits 100, writtenOff 400, notification 100 %.
- **Sync script**: `--dry-run` against a catalog fixture (pure `buildIntents` extracted for test) — meter + price intents emitted; `--verify` drift strings.
- **Manual (test mode)**: run `scripts/stripe-sync-catalog.mjs` with the test key → meter + 23 prices; enable PAYG for a test user via API; send a meter event; confirm it in the Stripe test Dashboard under the meter.

## 6. Rollout

1. Merge A–E to `develop` → stage → main via the normal cascade.
2. Operator: sync catalog in **test** mode (done in this branch), then **live** (owner confirms; legacy Chargebee `*` webhook caveat in the script banner).
3. Operator: set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENTS_ENABLED=true`, `SUBSCRIPTIONS_ENABLED=true` per environment (dev → stage → prod). Enforcement turns on automatically with the secret key; the daily sweep + lazy grant make free users' 50 credits available immediately.
4. Watch: `credits-meter-flush` failures, `payg past_due` counts, first PAYG invoices.
