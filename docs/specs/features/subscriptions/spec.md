# Feature Specification: Subscriptions & Plan Gating

**Feature ID**: `subscriptions`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The subscriptions feature is the platform's plan-tiering and usage-billing
surface. It seeds three first-party plans (`FREE`, `STANDARD`, `PREMIUM`) on
module init, exposes a two-endpoint HTTP surface (`GET /api/subscriptions/plan`
and `POST /api/subscriptions/plan`) for reading and switching the caller's
plan, and lends three reusable resolution primitives to downstream consumers
(`SubscriptionService.resolvePlanForUser`, `getCadenceAllowances`,
`requiresUsageBilling`) that drive plan-aware behaviour in
`WorkScheduleService` (cadence gating, `maxWorks` quota check, pay-per-use
fallthrough). It also wires a one-call usage-ledger pipeline
(`UsageLedgerService.recordUsage`) that writes a `UsageLedgerEntry` for every
billable usage event and fans the entry out to a pluggable `BillingProvider`
(default `ManualBillingProvider`, no external charge). The whole subsystem
short-circuits when `SUBSCRIPTIONS_ENABLED` is not the literal string
`'true'`: every cadence is reported as allowed-and-not-pay-per-use,
`requiresUsageBilling` always returns `false`, `recordUsage` returns `null`
without writing, and `assignPlanToUser` rejects with HTTP 400.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** subscriptions are disabled (`SUBSCRIPTIONS_ENABLED` ≠ `'true'`),
  **when** I call `GET /api/subscriptions/plan`, **then** the response is
  `{ status: 'success', enabled: false, plan: null }` and no plan resolution
  runs.
- **Given** subscriptions are enabled and I have no `user.defaultPlan` and no
  active `UserSubscription`, **when** I call `GET /api/subscriptions/plan`,
  **then** the response is `{ status: 'success', enabled: true, plan: {
code: 'free', name: 'Free', allowedCadences: [...] } }` where
  `allowedCadences` is the seven-cadence allowance grid resolved from the
  configured default plan (`SUBSCRIPTIONS_DEFAULT_PLAN`, falling back to
  `'free'`).
- **Given** I have an active `UserSubscription` whose plan is `PREMIUM`,
  **when** I call `GET /api/subscriptions/plan`, **then** the response plan
  code is `'premium'`, name is `'Premium'`, and every cadence in
  `allowedCadences` is `{ allowed: true, payPerUse: false }`.
- **Given** subscriptions are enabled, **when** I call `POST
/api/subscriptions/plan` with `{ planCode: 'standard' }`, **then** my
  `users.defaultPlanId` is updated to the row whose `code === 'standard'`,
  the response plan reflects the new code/name/allowances, and a subsequent
  `GET /api/subscriptions/plan` reflects the updated plan.
- **Given** my schedule on a `WEEKLY` cadence is allowed by the `STANDARD`
  plan, **when** `WorkScheduleService.markRunCompleted` finalises a run with
  `billingMode = 'subscription'`, **then** `UsageLedgerService.recordUsage`
  short-circuits and no ledger row is written.
- **Given** my plan is `STANDARD` (which does NOT allow `HOURLY`) and I want
  hourly updates, **when** I update the schedule with
  `billingMode = 'usage'` and `cadence = 'hourly'`, **then**
  `requiresUsageBilling` returns `false` (the schedule is accepted), and
  every completed run records a `UsageLedgerEntry` with
  `triggerType = 'scheduled'`, `billingMode = 'usage'`, `units = 1`, and
  `amountCents = round(PAY_PER_USE_PRICE_USD * 100)` (default `500`).
- **Given** subscriptions are enabled and I am on the `FREE` plan (which
  permits `MONTHLY` only in production seeds), **when** I try to switch a
  schedule to `HOURLY` with `billingMode = 'subscription'`, **then**
  `WorkScheduleService.updateSchedule` throws
  `BadRequestException({ status: 'error', message: 'Selected cadence is not
available on your plan. Switch to pay-per-use to continue.' })` (Note:
  the current `FREE` seed temporarily allows ALL cadences — see §6).

### 2.2 Edge cases & failures

- **Given** subscriptions are disabled, **when** I call `POST
/api/subscriptions/plan`, **then** the controller throws
  `BadRequestException('Subscriptions are disabled')` BEFORE any user
  lookup or plan assignment runs.
- **Given** subscriptions are enabled, **when** I call `POST
/api/subscriptions/plan` with a `planCode` that fails the
  `class-validator` `@IsEnum(SubscriptionPlanCode)` check, **then** the
  global validation pipe rejects the request with HTTP 400 BEFORE the
  controller body executes.
- **Given** subscriptions are enabled and `SUBSCRIPTIONS_DEFAULT_PLAN`
  resolves to a plan that has been deleted from the `subscription_plans`
  table, **when** `resolvePlanForUser` runs for a user with no subscription
  and no `defaultPlan`, **then** the service logs
  `Subscription plan <code> not found, falling back to FREE` at warn
  level and returns the `FREE` plan; if the `FREE` row is also missing, it
  throws `Error('Default subscription plan not found')`.
- **Given** the caller's `planCode` body is upper-case (e.g. `'STANDARD'`),
  **when** `assignPlanToUser` runs, **then** `normalizePlanCode` lowercases
  it, matches against `SubscriptionPlanCode` values, and falls back to
  `'free'` for any unknown code.
- **Given** `assignPlanToUser` is called with a code that normalises to a
  value not present in the `subscription_plans` table, **when** the
  repository lookup misses, **then** the service throws
  `NotFoundException('Plan not found')`.
- **Given** subscriptions are enabled and `WorkScheduleService.updateSchedule`
  is creating-or-activating a schedule, **when** the user's count of
  active schedules already equals `plan.maxWorks`, **then** the service
  throws `BadRequestException({ status: 'error', code:
'PLAN_LIMIT_EXCEEDED', message: 'Your <DisplayName> plan allows up to
<maxWorks> scheduled works.' })` BEFORE the upsert.
- **Given** `UsageLedgerService.recordUsage` is invoked with `billingMode =
'subscription'`, **when** the service runs, **then** it returns `null`
  without writing a ledger row even though subscriptions are enabled.
- **Given** the platform's `BillingProvider` raises while
  `recordUsageCharge` is awaited, **when** `recordUsage` runs, **then** the
  exception propagates back to the caller — there is no built-in retry
  loop and no in-memory swallowing today (see §6 OQ-3).
- **Given** the `subscription_plans` table is freshly created, **when**
  `SubscriptionService.onModuleInit` fires, **then** `seedPlans` upserts all
  three plans by `code` (rows whose `code` already exists are updated in
  place via `SubscriptionPlanRepository.upsert`, so the seeded
  `displayName`, `maxWorks`, `allowedCadences`, `monthlyPrice`,
  `overagePricePerRun`, and `currency` ALWAYS reflect the latest seed
  shape on every boot).

## 3. Functional Requirements

- **FR-1** The system MUST seed three plans (`FREE` / `STANDARD` /
  `PREMIUM`) on module init via
  `SubscriptionPlanRepository.upsert`, keyed on `code`.
- **FR-2** The system MUST expose `GET /api/subscriptions/plan` behind
  `AuthSessionGuard` returning `{ status: 'success', enabled, plan }` where
  `plan` is `null` when subscriptions are disabled and an
  `{ code, name, allowedCadences }` object otherwise.
- **FR-3** The system MUST expose `POST /api/subscriptions/plan` behind
  `AuthSessionGuard` accepting `{ planCode }` validated by
  `@IsEnum(SubscriptionPlanCode)`, throwing
  `BadRequestException('Subscriptions are disabled')` when subscriptions
  are off, and otherwise updating `users.defaultPlanId` and returning the
  same envelope as `GET`.
- **FR-4** The system MUST resolve a user's plan by precedence: active
  `UserSubscription.plan` → `user.defaultPlan` → configured default plan
  (`config.subscriptions.getDefaultPlanCode()`) → `FREE` fallback.
- **FR-5** The system MUST gate plan resolution on
  `config.subscriptions.isEnabled()`: when `false`, `resolvePlanForUser`
  returns the configured default plan (or FREE) and `getCadenceAllowances`
  returns every cadence as `{ allowed: true, payPerUse: false }`.
- **FR-6** The system MUST compute cadence allowances against the plan's
  `allowedCadences` set: cadences in the set are
  `{ allowed: true, payPerUse: false }`; cadences not in the set are
  `{ allowed: false, payPerUse: true, reason: 'Upgrade to <Tier> for
this cadence' }` where `<Tier>` is `Premium` for hourly/3h/8h cadences,
  `Standard` for 12h/daily/weekly, and `Free` for monthly.
- **FR-7** The system MUST expose `getDefaultCadence(plan)` that returns
  the LAST entry of `plan.allowedCadences` when the array is non-empty,
  falling back to `WorkScheduleCadence.MONTHLY` when empty.
- **FR-8** The system MUST expose `requiresUsageBilling(cadence, plan,
billingMode)` returning `false` when subscriptions are disabled OR the
  cadence is in the plan's allowed set; otherwise returning
  `billingMode !== 'usage'` (i.e. cadence not allowed AND not in usage
  mode).
- **FR-9** The system MUST refuse `assignPlanToUser` when subscriptions
  are disabled (`BadRequestException('Subscriptions are disabled')`) and
  when the resolved plan code does not exist in the table
  (`NotFoundException('Plan not found')`).
- **FR-10** The system MUST normalise `assignPlanToUser`'s `planCode` to
  lower-case, match against `SubscriptionPlanCode` values, and fall back
  to `'free'` for unknown codes.
- **FR-11** The system MUST mutate both the persisted `users.defaultPlanId`
  and the in-memory `user.defaultPlan` / `user.defaultPlanId` references
  after `assignPlanToUser` succeeds, so callers do not need to refetch.
- **FR-12** The system MUST short-circuit `UsageLedgerService.recordUsage`
  to `return null` when subscriptions are disabled OR
  `billingMode !== 'usage'`, writing no ledger row.
- **FR-13** The system MUST write a `UsageLedgerEntry` (units = 1,
  `amountCents = max(0, round(PAY_PER_USE_PRICE_USD * 100))` with default
  `5` USD → `500` cents, currency from `BillingProvider.getDefaultCurrency()`,
  metadata `{ cadence: schedule?.cadence }`) on every billable
  `recordUsage` call, then await
  `BillingProvider.recordUsageCharge(entry)`, then return the entry.
- **FR-14** The system MUST register a default `ManualBillingProvider` whose
  `recordUsageCharge` is a no-op `Promise<void>` returning `undefined`,
  and whose `getDefaultCurrency()` reads
  `config.billing.getDefaultCurrency()` (`BILLING_DEFAULT_CURRENCY` env,
  default `'usd'`).
- **FR-15** The system MUST refuse cadence transitions in
  `WorkScheduleService.updateSchedule` when
  `requiresUsageBilling(cadence, plan, billingMode)` returns `true`,
  throwing
  `BadRequestException({ status: 'error', message: 'Selected cadence is
not available on your plan. Switch to pay-per-use to continue.' })`
  BEFORE any persistence.
- **FR-16** The system MUST enforce `plan.maxWorks` in
  `WorkScheduleService.updateSchedule` when subscriptions are enabled and
  the request creates-or-activates a schedule: if
  `scheduleRepository.countActiveByUser(user.id) >= plan.maxWorks`, throw
  `BadRequestException({ status: 'error', code: 'PLAN_LIMIT_EXCEEDED',
message: 'Your <DisplayName> plan allows up to <maxWorks> scheduled
works.' })` BEFORE the upsert.
- **FR-17** The system MUST record a `UsageLedgerEntry` from
  `WorkScheduleService.markRunCompleted` ONLY (not from
  `markRunFailed` / `markRunSkipped`) — failed and skipped runs are free.
- **FR-18** The system MUST include `triggerType =
UsageLedgerTriggerType.SCHEDULED` on ledger rows written by
  `WorkScheduleService.markRunCompleted` and forward
  `generationHistoryId` from the call site to the ledger row.

## 4. Non-Functional Requirements

- **Performance**: `GET /api/subscriptions/plan` performs at most two DB
  reads (active subscription + user's default plan) plus the seven-row
  cadence-allowance projection that is purely computed in memory. No
  caching layer is currently inserted between the controller and the
  repository. P95 < 200 ms is comfortably achievable in a healthy DB.
- **Reliability**: `seedPlans` runs on every module bootstrap; an upsert
  failure is FATAL (it propagates out of `onModuleInit`, blocking
  module init). This is intentional — a partial seed produces inconsistent
  plan resolution.
- **Security & privacy**: The controller is mounted behind
  `AuthSessionGuard`, so plan reads/writes always require a valid
  session. `users.defaultPlanId` is the only column the user can mutate
  via this surface; `UserSubscription` rows (`status`,
  `currentPeriodEnd`, `cancelAtPeriodEnd`, `paymentMethodMeta`) are NOT
  exposed to the user.
- **Observability**: The service emits a single warn-level log line when
  the configured default plan is missing
  (`Subscription plan <code> not found, falling back to FREE`). No
  activity-log emission is produced for plan changes today (see §6
  OQ-2).
- **Compatibility**: Plan codes are a closed enum
  (`SubscriptionPlanCode`). Adding a tier requires (1) adding the enum
  value in `packages/agent/src/entities/types.ts`, (2) adding a row to
  `PLAN_SEED_DATA` in `subscription.service.ts`, (3) extending the
  recommendation helper. The `allowedCadences` JSON column is a `simple-json`
  array, so adding a new `WorkScheduleCadence` value is additive
  (forward-only — Constitution Principle V).

## 5. Key Entities & Domain Concepts

| Entity / concept              | Description                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SubscriptionPlan`            | Catalog row keyed by `code` (`SubscriptionPlanCode`). Holds `displayName`, `maxWorks`, `allowedCadences[]`, `monthlyPrice`, `overagePricePerRun`, `currency`, `active`.                                                                                                                          |
| `UserSubscription`            | Per-user active/canceled/past_due/trialing record linking a user to a plan via `planId`/`planCode`, with optional `currentPeriodEnd`, `cancelAtPeriodEnd`, `paymentMethodMeta`.                                                                                                                  |
| `UsageLedgerEntry`            | Per-billable-event row: `userId`, `workId`, optional `scheduleId`, `triggerType` (`manual`/`scheduled`), `billingMode` (`subscription`/`usage`), `units`, `amountCents`, `currency`, `status` (`pending`/`queued_for_settlement`/`paid`/`canceled`), optional `generationHistoryId`, `metadata`. |
| `SubscriptionPlanCode`        | Closed enum: `FREE = 'free'`, `STANDARD = 'standard'`, `PREMIUM = 'premium'`.                                                                                                                                                                                                                    |
| `SubscriptionStatus`          | Closed enum: `ACTIVE`, `CANCELED`, `PAST_DUE`, `TRIALING`. Only `ACTIVE` is consulted by `findActiveByUser`.                                                                                                                                                                                     |
| `SubscriptionBillingProvider` | Closed enum on `UserSubscription`: `STRIPE` (default), `MANUAL`. Today the platform-side billing-provider abstraction (`BillingProvider`) is independent of this column.                                                                                                                         |
| `UsageLedgerTriggerType`      | Closed enum: `MANUAL`, `SCHEDULED`. The current consumer (`WorkScheduleService`) writes `SCHEDULED` exclusively.                                                                                                                                                                                 |
| `UsageLedgerStatus`           | Closed enum: `PENDING` (default), `QUEUED_FOR_SETTLEMENT`, `PAID`, `CANCELED`. `recordUsage` writes the default; promotion to `QUEUED_FOR_SETTLEMENT` is via `markQueued(ids)`.                                                                                                                  |
| `WorkScheduleBillingMode`     | Closed enum imported from `@ever-works/contracts/api`: `SUBSCRIPTION`, `USAGE`. Stored on `WorkSchedule.billingMode`.                                                                                                                                                                            |
| `WorkScheduleAllowedCadence`  | DTO: `{ cadence, allowed, payPerUse, reason? }`. The shape `getCadenceAllowances` returns and the API surfaces.                                                                                                                                                                                  |
| `BillingProvider`             | Abstract NestJS provider with `getDefaultCurrency(): string` and `recordUsageCharge(entry): Promise<void>` (no-op default).                                                                                                                                                                      |
| `ManualBillingProvider`       | Default registered impl: returns `config.billing.getDefaultCurrency()`, no remote charge.                                                                                                                                                                                                        |

## 6. Out of Scope

- Stripe webhook handling (`POST /api/subscriptions/webhook`) — the
  architecture spec describes one but no controller exists yet.
- Stripe Checkout / portal redirection — `createCheckoutSession` is
  mentioned in the architecture spec but not implemented.
- Per-feature gating (custom domains, member invites, agent-pipeline) —
  the plan model has fields for these in the architecture spec
  (`canInviteMembers`, `canUseCustomDomains`, `canUseAgentPipeline`) but
  the entity and service do NOT carry them today.
- Plan-tier discovery API — there is no `GET /api/subscriptions/plans`
  catalog endpoint; clients hard-code the plan code list.
- The current `FREE` seed temporarily lists `ALL_CADENCES` as
  `allowedCadences` (with the production list commented out). This is a
  deliberate "everything is free for now" override; restoring the
  production gate by uncommenting `[WorkScheduleCadence.MONTHLY]` is a
  follow-up captured in `tasks.md` as T18.
- Trigger.dev retry of `failed` ledger entries — referenced in the
  architecture spec; no implementation today.
- Activity-log emission on plan change — not currently produced.

## 7. Acceptance Criteria

- [ ] `GET /api/subscriptions/plan` returns `{ enabled: false, plan:
  null }` when `SUBSCRIPTIONS_ENABLED` is unset / not `'true'`.
- [ ] `GET /api/subscriptions/plan` returns the resolved plan with the
      seven-cadence allowance grid when subscriptions are enabled.
- [ ] `POST /api/subscriptions/plan` rejects with HTTP 400 when
      subscriptions are disabled, BEFORE any user lookup runs.
- [ ] `POST /api/subscriptions/plan` updates `users.defaultPlanId` to
      the row matching the normalised plan code and returns the same
      envelope as `GET`.
- [ ] `POST /api/subscriptions/plan` rejects with HTTP 400 when the
      `planCode` body is not a member of `SubscriptionPlanCode` (validation
      pipe).
- [ ] `assignPlanToUser` throws `NotFoundException` when the resolved
      plan code is not present in the table.
- [ ] `resolvePlanForUser` walks the active-subscription → default-plan →
      config-default → FREE-fallback chain, with the warn log emitted on
      the FREE-fallback branch.
- [ ] `requiresUsageBilling` returns `false` when subscriptions are
      disabled, returns `false` when the cadence is in the plan's allowed
      set, and otherwise returns `billingMode !== 'usage'`.
- [ ] `getCadenceAllowances` produces every cadence with the correct
      `{ allowed, payPerUse, reason? }` shape, and the entire grid is
      `{ allowed: true, payPerUse: false }` when subscriptions are
      disabled.
- [ ] `UsageLedgerService.recordUsage` short-circuits to `null` when
      subscriptions are disabled OR `billingMode !== 'usage'`.
- [ ] `UsageLedgerService.recordUsage` writes a row with
      `units = 1`, `amountCents = max(0, round(PAY_PER_USE_PRICE_USD *
  100))`, `currency` from `BillingProvider.getDefaultCurrency()`, and
      `metadata.cadence = schedule.cadence`, then awaits
      `BillingProvider.recordUsageCharge(entry)`.
- [ ] `WorkScheduleService.markRunCompleted` records a ledger row;
      `markRunFailed` / `markRunSkipped` do NOT.
- [ ] `WorkScheduleService.updateSchedule` rejects cadence transitions
      that fail `requiresUsageBilling`, and rejects creation when
      `countActiveByUser(user.id) >= plan.maxWorks`.
- [ ] `seedPlans` is idempotent — re-running it overwrites the catalog
      rows with the latest `PLAN_SEED_DATA` shape, never produces
      duplicates.
- [ ] All functional requirements have at least one passing unit or e2e
      test.

## 8. Open Questions

- `[NEEDS CLARIFICATION: OQ-1 — `FREE`seed currently allows ALL cadences (line 40 in`subscription.service.ts`: `allowedCadences: ALL_CADENCES // for now everything is free`). When does the production gate (`[WorkScheduleCadence.MONTHLY]`) ship? The behaviour spec describes the production-gated semantics, but the test suite must pin the current "everything free" behaviour or the tests will fail.]`
- `[NEEDS CLARIFICATION: OQ-2 — Should plan changes emit an activity-log entry (e.g. `user.subscription_plan_changed`)? Today the controller does not emit one, while almost every other settings endpoint does.]`
- `[NEEDS CLARIFICATION: OQ-3 — `UsageLedgerService.recordUsage`does not wrap`billingProvider.recordUsageCharge(entry)`in a try/catch. A throwing billing provider crashes the originating run-completion path. The architecture spec describes a Trigger.dev retry loop for`failed`entries, but the entries are never marked`failed`today (status stays`PENDING`).]`
- `[NEEDS CLARIFICATION: OQ-4 — `UserSubscription.billingProvider`defaults to`STRIPE`even though no Stripe integration is wired. This is the column carrying the per-user provider; the platform-side`BillingProvider`abstract class is separate. Should the default be`MANUAL` until Stripe lands?]`
- `[NEEDS CLARIFICATION: OQ-5 — `assignPlanToUser`mutates`user.defaultPlan`/`user.defaultPlanId`in-place on the in-memory entity. This is convenient for the controller's immediate`summarizePlan` call but can cause subtle staleness in callers that hold an older reference. Document or remove?]`

## 9. Constitution Gates

- [ ] Plugin-first if introducing an external integration (Principle I) — N/A: `BillingProvider` is an internal abstract class today, not a plugin.
- [ ] Capability-driven resolution if touching cross-plugin behaviour (Principle II) — N/A: subscriptions resolve via per-user plan, not per-capability.
- [x] Source-of-truth repos preserved (Principle III) — plan / subscription data is platform-side, never mirrored to user repos.
- [x] Long-running work via Trigger.dev (Principle IV) — N/A today (no remote charge), but `BillingProvider.recordUsageCharge` is the future Trigger.dev hook.
- [x] Schema changes ship as forward-only migrations (Principle V) — `subscription_plans`, `user_subscriptions`, `usage_ledger_entries` are additive tables; new plan codes / cadences are additive enum values.
- [x] Tests accompany the change (Principle VI) — `subscriptions.controller.spec.ts` covers both endpoints; agent-package suites cover `subscription.service.ts` and `usage-ledger.service.ts`.
- [x] Secrets handled per `x-secret` rules (Principle VII) — `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` read from env only; never logged.
- [x] Plugin counts touch the canonical doc only (Principle VIII) — N/A.
- [x] Behaviour-first — no implementation in this spec (Principle IX) — implementation lives in `plan.md`.
- [x] Backwards-compatible API/SDK/schema changes (Principle X) — no breaking change.

## 10. References

- Source:
    - `apps/api/src/subscriptions/subscriptions.controller.ts`
    - `apps/api/src/subscriptions/subscriptions.module.ts`
    - `packages/agent/src/subscriptions/subscription.service.ts`
    - `packages/agent/src/subscriptions/usage-ledger.service.ts`
    - `packages/agent/src/subscriptions/billing/billing.provider.ts`
    - `packages/agent/src/entities/subscription-plan.entity.ts`
    - `packages/agent/src/entities/user-subscription.entity.ts`
    - `packages/agent/src/entities/usage-ledger-entry.entity.ts`
    - `packages/agent/src/database/repositories/subscription-plan.repository.ts`
    - `packages/agent/src/database/repositories/user-subscription.repository.ts`
    - `packages/agent/src/database/repositories/usage-ledger.repository.ts`
- Related architecture: [`docs/specs/architecture/subscriptions.md`](../../architecture/subscriptions.md)
- Related features:
    - [`features/scheduled-updates/spec`](../scheduled-updates/spec.md)
    - [`features/comparisons/spec`](../comparisons/spec.md)
    - [`features/custom-domains/spec`](../custom-domains/spec.md)
- User-facing docs:
    - [`docs/api/subscriptions.md`](../../../api/subscriptions.md)
    - [`docs/advanced/subscription-billing.md`](../../../advanced/subscription-billing.md)
    - [`docs/agent-services/subscriptions-module.md`](../../../agent-services/subscriptions-module.md)
