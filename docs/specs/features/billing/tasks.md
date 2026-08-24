# Tasks: Billing — Credits, Plans, Seats and Pay-as-you-go

> Checklist for [`spec.md`](./spec.md) / [`plan.md`](./plan.md). One PR per letter; tick as merged.

## PR-A — plan credit grants, expiring buckets, universal daily grant

- [ ] Entity: `CreditLedgerEntry.expiresAt`, `remainingCredits`; entities inventory unchanged (same entity)
- [ ] Migration `AddCreditLedgerBuckets`: columns + index + backfill (remaining = amount; replay debits per user) + entitlement seeds (`daily-free-credits=50` standard/premium)
- [ ] `CreditLedgerRepository`: bucket allocation on negative writes; `expireDueBuckets`; available `getBalance`; `getPeriodTotals` split; `findUsersWithDueBuckets`
- [ ] `CreditLedgerService`: `record({expiresAt})`, `expireDueCredits`, universal daily fallback, `grantForToday`
- [ ] `PlanCreditGrantService` + `allowancePeriodFor` + `UserSubscriptionRepository.findActiveBatch`
- [ ] `PlanSubscriptionService.activate` → grant current allowance
- [ ] Trigger `credits-daily-grant` → expiries + daily + plan grants; RPC allow-list
- [ ] Specs: repository allocation/expiry, service, plan-grant service, settlement expire-on-touch, task
- [ ] Docs touched: `docs/features/credits-and-billing.md` (ledger kinds table now complete)

## PR-B — margin as a catalog value + pricing endpoint

- [ ] Catalog `creditsMarginPercent: 35`; `stripe-catalog.ts` getter; config fallback
- [ ] `GET /api/credits/pricing` + web `creditsAPI.pricing()`; Usage page conversion copy
- [ ] Spec pins economics table; docs updated

## PR-C — pay-as-you-go (Stripe Billing Meters)

- [ ] Catalog `payg` section + `stripe-catalog.ts` (`getPaygCatalog`, `estimatePaygCents`, `PAYG_LOOKUP_KEY`)
- [ ] `scripts/stripe-sync-catalog.mjs`: meter + metered tiered price (create/replace/verify)
- [ ] Entities: `BillingProfile` payg columns; `CreditMeterEvent` (+ inventory); repositories
- [ ] Migration `AddPaygAndMeterEvents` + `credit-limited=1` seeds (free/standard/premium)
- [ ] Seam: `createMeteredSubscription`, `cancelMeteredSubscriptionNow`, `reportMeterEvent`, `retrieveSubscriptionSnapshot`; webhook kinds `payg.updated`, invoice `subscriptionKind`/`paymentFailed`
- [ ] `StripeBillingProvider`: the four calls, metadata kind `payg-subscription`, normalization, `automatic_tax` / `tax_id_collection` flags
- [ ] `PaygService` (state/enable/updateCap/disable/cycleUsage/headroom/recordOverflow/applyWebhook/flushPending/notify)
- [ ] `BillingService`: overview `payg`, webhook routing (`payg.updated`, PAYG invoices → status)
- [ ] `RunCostSettlementService`: overflow to PAYG, lazy daily grant in precheck, headroom admission
- [x] Config: enforcement default-on-when-configured, `PAYG_MAX_MONTHLY_CAP_CREDITS` (Stripe Tax needs no flag — unconditional since #2203)
- [ ] Trigger task `credits-meter-flush` (\*/5) + RPC allow-list
- [ ] API: `payg.controller.ts` (GET/PUT) + DTO + module wiring + specs
- [ ] Web: `billing.shared.ts` (types, `canConfigurePayg`, `estimatePaygCents`), server action, `BillingSettings` PAYG card, Usage tile, en.json keys, plan-card label fix
- [ ] Notifications: `notifyPaygCapThreshold`, `notifyPaygPastDue`
- [ ] Docs: `docs/features/credits-and-billing.md`, `docs/advanced/subscription-billing.md`, `docs/api/subscriptions.md`, `docs/agent-services/subscriptions-module.md`, `docs/runbooks/BILLING_STRIPE_OPERATIONS.md`, `.env.example`, sidebar
- [ ] Test-mode catalog sync run + verify (0 drift); note in runbook

## PR-D — seats

- [ ] Entity `UserSubscription.seats`, `providerSeatItemId`; migration `AddSubscriptionSeats`
- [ ] Seam `updateSeatQuantity`, snapshot `seats`/`seatItemId`; provider impl + normalization
- [ ] `SeatsService` + repository counters; `SeatLimitExceededError` → 402
- [ ] Gates in `OrganizationMembershipService` / invitations accept + `AgentsService.create`
- [ ] `PlanSubscriptionService` persist seats; `summarizePlan` seats block
- [ ] API `GET/POST /billing/seats` + DTO + specs; web seats row + "Add seats"
- [ ] Docs

## Follow-ups (Jira)

- [ ] Org-pooled wallets / billing owner for organisations
- [ ] Remove deprecated per-run pay-per-use path (needs confirmation)
- [ ] Website `/pricing` PAYG row (`ever-works/website`)
- [ ] Live-mode catalog sync + prod env wiring (operator)
