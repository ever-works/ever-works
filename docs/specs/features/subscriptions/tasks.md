# Task Breakdown: Subscriptions & Plan Gating

**Feature ID**: `subscriptions`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## Phase 1 — Plan Catalog & Seed

- [x] T1. `SubscriptionPlan` entity at
      `packages/agent/src/entities/subscription-plan.entity.ts` with
      `id` (uuid PK), `code` (`SubscriptionPlanCode` unique), `displayName`,
      `maxWorks`, `allowedCadences` (`simple-json` array of
      `WorkScheduleCadence`), `monthlyPrice` / `overagePricePerRun`
      (`decimal(10,2)`), `currency` (default `'usd'`), `active` (default
      `true`), `createdAt` / `updatedAt`.
- [x] T2. `SubscriptionPlanRepository` (`findByCode`, `findAllActive`,
      `upsert`) at
      `packages/agent/src/database/repositories/subscription-plan.repository.ts`.
- [x] T3. `PLAN_SEED_DATA` table in
      `packages/agent/src/subscriptions/subscription.service.ts` with
      three rows (`free` / `standard` / `premium`) — `maxWorks`
      (1 / 5 / 15), tier-appropriate `allowedCadences`, `monthlyPrice`
      (`'0'` / `'29'` / `'99'`), `overagePricePerRun` (`'10'` / `'8'` /
      `'0'`).
- [x] T4. `SubscriptionService.onModuleInit` → `seedPlans()`:
      `Promise.all(PLAN_SEED_DATA.map(plan => upsert({ ...plan, currency:
config.billing.getDefaultCurrency(), active: true })))`. Idempotent
      via `findByCode` lookup inside `upsert`.

## Phase 2 — Per-User Subscription & Usage Schema

- [x] T5. `UserSubscription` entity at
      `packages/agent/src/entities/user-subscription.entity.ts` with
      `userId` (FK + `ON DELETE CASCADE`), `planCode`, `planId` (FK,
      eager-loaded), `status` (`SubscriptionStatus` enum,
      default `ACTIVE`), `billingProvider`
      (`SubscriptionBillingProvider` enum, default `STRIPE`),
      `currentPeriodEnd` (nullable timestamp), `cancelAtPeriodEnd`,
      `paymentMethodMeta` (json nullable). Composite indexes on
      `(userId, status)` and `(planCode)`.
- [x] T6. `UserSubscriptionRepository` (`findActiveByUser`, `listByUser`,
      `createOrUpdate`, `cancel`) at
      `packages/agent/src/database/repositories/user-subscription.repository.ts`.
- [x] T7. `UsageLedgerEntry` entity at
      `packages/agent/src/entities/usage-ledger-entry.entity.ts` with
      `userId`/`workId` (FK + `ON DELETE CASCADE`), `scheduleId`
      (FK + `ON DELETE SET NULL`), `triggerType`
      (`UsageLedgerTriggerType` enum), `billingMode`
      (`WorkScheduleBillingMode` enum), `units` (default `1`),
      `amountCents` (default `0`), `currency` (default `'usd'`),
      `status` (`UsageLedgerStatus`, default `PENDING`),
      `generationHistoryId` (FK nullable), `metadata` (json nullable).
      Indexes on `(userId, status)`, `(workId)`, `(createdAt)`,
      `(scheduleId)`.
- [x] T8. `UsageLedgerRepository` (`record`, `findPendingByUser`,
      `markQueued`, `getUsageSummary`) at
      `packages/agent/src/database/repositories/usage-ledger.repository.ts`.

## Phase 3 — Resolution Service

- [x] T9. `SubscriptionService.isEnabled()` reads
      `config.subscriptions.isEnabled()` (env var `SUBSCRIPTIONS_ENABLED
=== 'true'`).
- [x] T10. `SubscriptionService.getActiveSubscription(userId)` →
      `userSubscriptionRepository.findActiveByUser(userId)`.
- [x] T11. `SubscriptionService.resolvePlanForUser(user)` four-level
      chain: subscriptions-disabled → `resolveDefaultPlan`; active
      subscription with `plan` → `subscription.plan`; `user.defaultPlan` →
      that plan; otherwise → `resolveDefaultPlan`.
- [x] T12. `SubscriptionService.resolveDefaultPlan()` reads
      `config.subscriptions.getDefaultPlanCode()` (default `'free'`),
      normalises via `normalizePlanCode`, looks up the plan; on miss
      logs warn (`Subscription plan <code> not found, falling back to
FREE`) and falls back to `FREE`; throws when neither resolves.
- [x] T13. `SubscriptionService.normalizePlanCode(value)`:
      `value?.toLowerCase()`; if it matches a `SubscriptionPlanCode`
      value, return it; otherwise return `SubscriptionPlanCode.FREE`.
- [x] T14. `SubscriptionService.getCadenceAllowances(user)`: when
      disabled, returns the seven-cadence grid as
      `{ allowed: true, payPerUse: false }`; otherwise resolves the
      plan, builds a `Set` from `plan.allowedCadences`, and projects
      every cadence with `{ allowed, payPerUse: !allowed, reason }`
      where `reason` interpolates `recommendationForCadence(cadence)`
      (`Premium` for hourly/3h/8h, `Standard` for 12h/daily/weekly,
      `Free` for monthly).
- [x] T15. `SubscriptionService.getDefaultCadence(plan)` returns the
      LAST entry of `plan.allowedCadences` or `MONTHLY` when empty.
- [x] T16. `SubscriptionService.requiresUsageBilling(cadence, plan,
billingMode)`: returns `false` when subscriptions are disabled
      OR cadence is in the plan's allowed set; otherwise returns
      `billingMode !== USAGE`.

## Phase 4 — Plan Assignment

- [x] T17. `SubscriptionService.assignPlanToUser(user, planCode)`:
      throws `BadRequestException('Subscriptions are disabled')` when
      disabled; normalises the code; throws
      `NotFoundException('Plan not found')` on missing plan; updates
      `users.defaultPlanId`; mutates `user.defaultPlan` /
      `user.defaultPlanId` in place; returns the resolved plan.
- [ ] T18. **OPEN** — Restore the production `FREE` cadence gate
      (uncomment `[WorkScheduleCadence.MONTHLY]` and remove the
      `ALL_CADENCES` override on line 40 of `subscription.service.ts`).
      Requires updating `subscription.service.spec.ts` to assert the
      tightened gate. Tracked as OQ-1.
- [x] T19. `SubscriptionService.summarizePlan(user)`:
      `Promise.all([resolvePlanForUser(user),
getCadenceAllowances(user)])` → `{ plan, allowances, enabled:
isEnabled() }`.

## Phase 5 — HTTP Surface

- [x] T20. `SubscriptionsController` at
      `apps/api/src/subscriptions/subscriptions.controller.ts` mounted
      on `/api/subscriptions` behind `AuthSessionGuard` with
      `@ApiTags('Subscriptions')` + `@ApiBearerAuth('JWT-auth')`.
- [x] T21. `GET /plan` runs `authService.getUser(auth.userId)` →
      `subscriptionService.summarizePlan(user)`; when
      `summary.enabled === false` returns `{ status: 'success', enabled:
false, plan: null }`; otherwise returns
      `{ status: 'success', enabled: true, plan: { code:
summary.plan.code, name: summary.plan.displayName,
allowedCadences: summary.allowances } }`.
- [x] T22. `POST /plan` `UpdateSubscriptionPlanDto` with
      `@IsEnum(SubscriptionPlanCode)` on `planCode`. Body throws 400
      via the validation pipe when the code is unknown.
- [x] T23. `POST /plan` controller body: throws
      `BadRequestException('Subscriptions are disabled')` when
      disabled (BEFORE any user lookup); resolves user via
      `authService.getUser`; calls `assignPlanToUser`; calls
      `summarizePlan(user)`; returns `{ status: 'success', enabled:
true, plan: { code: plan.code, name: plan.displayName,
allowedCadences: summary.allowances } }`.

## Phase 6 — Usage-Ledger Pipeline

- [x] T24. `BillingProvider` abstract class at
      `packages/agent/src/subscriptions/billing/billing.provider.ts`
      with `getDefaultCurrency(): string` and
      `recordUsageCharge(entry: UsageLedgerEntry): Promise<void>`
      (no-op default).
- [x] T25. `ManualBillingProvider` (`@Injectable`) returns
      `config.billing.getDefaultCurrency()` from `getDefaultCurrency`
      and inherits the no-op `recordUsageCharge`.
- [x] T26. `UsageLedgerService.recordUsage(options)`:
      short-circuits to `null` when subscriptions are disabled OR
      `options.billingMode !== USAGE`. Otherwise:
      `amountCents = config.subscriptions.getPayPerUsePriceCents()`,
      `entry = await ledgerRepository.record({...})` with
      `{ userId, workId, scheduleId: schedule?.id, triggerType,
billingMode, units: 1, amountCents, currency:
billingProvider.getDefaultCurrency(), generationHistoryId,
metadata: { cadence: schedule?.cadence } }`,
      then `await billingProvider.recordUsageCharge(entry)`,
      then return `entry`.
- [x] T27. Module wiring at
      `packages/agent/src/subscriptions/subscriptions.module.ts`:
      imports `DatabaseModule`; providers `SubscriptionService`,
      `UsageLedgerService`, `{ provide: BillingProvider, useClass:
ManualBillingProvider }`; exports all three so consumers can
      inject `SubscriptionService` / `UsageLedgerService` /
      `BillingProvider`.
- [x] T28. `apps/api` re-export at
      `apps/api/src/subscriptions/subscriptions.module.ts`: imports
      `AuthModule` and the agent `SubscriptionsModule`; registers
      `SubscriptionsController`.

## Phase 7 — Schedule Integration (Cross-Cutting Consumer)

- [x] T29. `WorkScheduleService.getSchedule(workId, user)` resolves
      `[schedule, allowances, plan, readiness]` in parallel and emits
      a DTO with `subscriptionsEnabled` from
      `subscriptionService.isEnabled()`.
- [x] T30. `WorkScheduleService.updateSchedule(workId, dto, user)` runs
      `subscriptionService.requiresUsageBilling(cadence, plan,
billingMode)` BEFORE persistence — when `true`, throws
      `BadRequestException({ status: 'error', message: 'Selected
cadence is not available on your plan. Switch to pay-per-use to
continue.' })`.
- [x] T31. `WorkScheduleService.updateSchedule(workId, dto, user)`
      enforces `plan.maxWorks` when subscriptions are enabled and the
      request creates-or-activates: throws
      `BadRequestException({ status: 'error', code:
'PLAN_LIMIT_EXCEEDED', message: 'Your <DisplayName> plan allows
up to <maxWorks> scheduled works.' })` when
      `scheduleRepository.countActiveByUser(user.id) >= plan.maxWorks`.
- [x] T32. `WorkScheduleService.updateSchedule` defaults the cadence to
      `subscriptionService.getDefaultCadence(plan)` when neither
      `dto.cadence` nor `existing?.cadence` is set; throws
      `BadRequestException('Cadence is required to enable scheduled
updates')` when nothing resolves.
- [x] T33. `WorkScheduleService.markRunCompleted` calls
      `usageLedgerService.recordUsage({ userId, workId, schedule,
triggerType: SCHEDULED, billingMode: schedule.billingMode,
generationHistoryId })`.
- [x] T34. `WorkScheduleService.markRunFailed` and
      `markRunSkipped` do NOT call `recordUsage` (failed / skipped
      runs are free).

## Phase 8 — Tests

- [x] T35. `subscriptions.controller.spec.ts` (9 tests, PR #496) —
      `getPlan` enabled-false envelope, mapped-success envelope,
      `getUser` + `summarizePlan` error propagation; `updatePlan`
      BadRequest when disabled (no `getUser` / `assignPlanToUser`),
      mapped-success envelope, plan source = `assignPlanToUser`
      response, error propagation.
- [x] T36. `subscription.service.spec.ts` — covers `isEnabled`,
      `seedPlans` upsert calls, `resolvePlanForUser` four-level chain
      (subscription → defaultPlan → config default → FREE fallback),
      `getCadenceAllowances` allowed/payPerUse/reason projection
      (both enabled and disabled), `requiresUsageBilling` truth table
      (disabled, allowed, billingMode-USAGE, billingMode-non-USAGE),
      `getDefaultCadence` (non-empty + empty), `assignPlanToUser`
      (disabled / normalisation / missing plan / happy path with
      in-place mutation), `resolveDefaultPlan` warn log on FREE
      fallback, throw when both default and FREE missing.
- [x] T37. `usage-ledger.service.spec.ts` — `recordUsage`
      short-circuits to `null` when subscriptions are disabled,
      short-circuits when `billingMode !== USAGE`, writes a row with
      the correct `amountCents` / `currency` / `metadata.cadence`
      shape and forwards optional `generationHistoryId`, fans out to
      `billingProvider.recordUsageCharge(entry)`, returns the entry.
- [x] T38. `work-schedule.service.spec.ts` (consumer side) — pins the
      cadence-gate (`BadRequestException` w/ `Switch to pay-per-use to
continue.`), `PLAN_LIMIT_EXCEEDED` (count vs `maxWorks`),
      `markRunCompleted` ledger write, `markRunFailed` /
      `markRunSkipped` no-write.
- [ ] T39. **FOLLOW-UP** — Add a Postgres-container integration test
      that exercises the full ledger pipeline: enable subscriptions,
      assign `STANDARD` plan, switch a schedule to `HOURLY` +
      `billingMode = 'usage'`, run `markRunCompleted`, assert one
      `usage_ledger_entries` row with `amountCents = 500`,
      `triggerType = 'scheduled'`, `metadata.cadence = 'hourly'`,
      `status = 'pending'`. Currently covered only at unit level with
      mocked repositories.
- [ ] T40. **FOLLOW-UP** — Add an e2e test against
      `GET/POST /api/subscriptions/plan` (currently controller-level
      unit suite only) verifying the `AuthSessionGuard` 401 path, the
      `@IsEnum` 400 path, and the round-trip plan switch.

## Phase 9 — Open Questions / Outstanding Work

- [ ] T41. **OQ-1** — Restore the production `FREE` cadence gate (see
      T18). Current behaviour is "everything is free for now"; the
      spec describes the production-gated semantics.
- [ ] T42. **OQ-2** — Decide whether to emit an activity-log entry on
      plan change. If yes, fire-and-forget
      `activityLogService.log({ userId: user.id, action:
'user.subscription_plan_changed', actionType: SETTINGS_UPDATED,
details: { oldCode, newCode } }).catch(() => {})` from
      `updatePlan` AFTER `assignPlanToUser` resolves.
- [ ] T43. **OQ-3** — Wrap
      `billingProvider.recordUsageCharge(entry)` in a try/catch in
      `UsageLedgerService.recordUsage`: on failure, mark the entry as
      `'failed'` (not `'pending'`) so a future Trigger.dev retry task
      can pick it up, and log via `logger.error`.
- [ ] T44. **OQ-4** — Default `UserSubscription.billingProvider` to
      `MANUAL` until Stripe lands; flip to `STRIPE` only when the
      Stripe `BillingProvider` impl is registered.
- [ ] T45. **OQ-5** — Decide whether `assignPlanToUser` should
      refetch the user instead of mutating in place. Today the
      mutation saves a DB roundtrip in the controller's hot path;
      the trade-off is potential staleness in callers that hold an
      older reference.

## Definition of Done

- All FRs in `spec.md` map to a passing test.
- The HTTP surface is covered by both unit and (eventually) e2e tests.
- The agent-package services have unit suites for both
  `SubscriptionService` and `UsageLedgerService`.
- The `WorkScheduleService` consumer pins both the cadence gate and
  the post-completion ledger write.
- `COVERAGE-TRACKER.md` reflects the spec landing under
  "Pending — Medium Priority → Spec Kit features that need a spec".
