# Tasks: Billing — Credits, Plans, Seats and Pay-as-you-go

> Checklist for [`spec.md`](./spec.md) / [`plan.md`](./plan.md). One PR per letter; tick as merged.

## PR-A — plan credit grants, expiring buckets, universal daily grant

- [x] Entity: `CreditLedgerEntry.expiresAt`, `remainingCredits`; entities inventory unchanged (same entity)
- [x] Migration `AddCreditLedgerBuckets`: columns + index + backfill (remaining = amount; replay debits per user) + entitlement seeds (`daily-free-credits=50` standard/premium)
- [x] `CreditLedgerRepository`: bucket allocation on negative writes; `expireDueBuckets`; available `getBalance`; `getPeriodTotals` split; `findUsersWithDueBuckets`
- [x] `CreditLedgerService`: `record({expiresAt})`, `expireDueCredits`, universal daily fallback, `grantForToday`
- [x] `PlanCreditGrantService` + `allowancePeriodFor` + `UserSubscriptionRepository.findActiveBatch`
- [x] `PlanSubscriptionService.activate` → grant current allowance
- [x] Trigger `credits-daily-grant` → expiries + daily + plan grants; RPC allow-list
- [x] Specs: repository allocation/expiry, service, plan-grant service, settlement expire-on-touch, task
- [x] Docs touched: `docs/features/credits-and-billing.md` (ledger kinds table now complete)

## PR-B — margin as a catalog value + pricing endpoint

- [x] Catalog `creditsMarginPercent: 35`; `stripe-catalog.ts` getter; config fallback
- [x] `GET /api/credits/pricing` + web `creditsAPI.pricing()`; Usage page conversion copy
- [x] Spec pins economics table; docs updated

## PR-C — pay-as-you-go (Stripe Billing Meters)

- [x] Catalog `payg` section + `stripe-catalog.ts` (`getPaygCatalog`, `estimatePaygCents`, `PAYG_LOOKUP_KEY`)
- [x] `scripts/stripe-sync-catalog.mjs`: meter + metered tiered price (create/replace/verify)
- [x] Entities: `BillingProfile` payg columns; `CreditMeterEvent` (+ inventory); repositories
- [x] Migration `AddPaygAndMeterEvents` + `credit-limited=1` seeds (free/standard/premium)
- [x] Seam: `createMeteredSubscription`, `cancelMeteredSubscriptionNow`, `reportMeterEvent`, `retrieveSubscriptionSnapshot`; webhook kinds `payg.updated`, invoice `subscriptionKind`/`paymentFailed`
- [x] `StripeBillingProvider`: the four calls, metadata kind `payg-subscription`, normalization, `automatic_tax` / `tax_id_collection` flags
- [x] `PaygService` (state/enable/updateCap/disable/cycleUsage/headroom/recordOverflow/applyWebhook/flushPending/notify)
- [x] `BillingService`: overview `payg`, webhook routing (`payg.updated`, PAYG invoices → status)
- [x] `RunCostSettlementService`: overflow to PAYG, lazy daily grant in precheck, headroom admission
- [x] Config: enforcement default-on-when-configured, `PAYG_MAX_MONTHLY_CAP_CREDITS` (Stripe Tax needs no flag — unconditional since #2203)
- [x] Trigger task `credits-meter-flush` (\*/5) + RPC allow-list
- [x] API: `payg.controller.ts` (GET/PUT) + DTO + module wiring + specs
- [x] Web: `billing.shared.ts` (types, `canConfigurePayg`, `estimatePaygCents`), server action, `BillingSettings` PAYG card, Usage tile, en.json keys, plan-card label fix
- [x] Notifications: `notifyPaygCapThreshold`, `notifyPaygPastDue`
- [x] Docs: `docs/features/credits-and-billing.md`, `docs/advanced/subscription-billing.md`, `docs/api/subscriptions.md`, `docs/agent-services/subscriptions-module.md`, `docs/runbooks/BILLING_STRIPE_OPERATIONS.md`, `.env.example`, sidebar
- [x] Test-mode catalog sync run + verify (0 drift); note in runbook

## PR-D — seats

- [x] Entity `UserSubscription.seats`, `providerSeatItemId`; migration `AddSubscriptionSeats`
- [x] Seam `updateSeatQuantity`, snapshot `seats`/`seatItemId`; provider impl + normalization
- [x] `SeatsService` + repository counters; `SeatLimitExceededError` → 402
- [x] Gates in `OrganizationMembershipService` / invitations accept + `AgentsService.create`
- [x] `PlanSubscriptionService` persist seats; `summarizePlan` seats block
- [x] API `GET/POST /billing/seats` + DTO + specs; web seats row + "Add seats"
- [x] Docs

## Follow-ups (Jira)

- [ ] Org-pooled wallets / billing owner for organisations
- [ ] Remove deprecated per-run pay-per-use path (needs confirmation)
- [ ] Website `/pricing` PAYG row (`ever-works/website`)
- [ ] Live-mode catalog sync + prod env wiring (operator)
