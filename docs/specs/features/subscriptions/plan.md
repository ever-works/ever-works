# Implementation Plan: Subscriptions & Plan Gating

**Feature ID**: `subscriptions`
**Spec**: `./spec.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## 1. Architecture

```mermaid
flowchart TD
    Client[HTTP client] -->|GET/POST /api/subscriptions/plan| Ctrl[SubscriptionsController]
    Ctrl --> Auth[AuthSessionGuard\n(@src/auth)]
    Ctrl -->|getPlan / updatePlan| AuthSvc[AuthService.getUser]
    Ctrl --> SubSvc[SubscriptionService\nsummarizePlan / assignPlanToUser / isEnabled]
    SubSvc -->|seedPlans onModuleInit| PlanRepo[(subscription_plans)]
    SubSvc -->|findActiveByUser| UserSubRepo[(user_subscriptions)]
    SubSvc -->|update defaultPlanId| UserRepo[(users)]
    SubSvc --> ConfigSubs[config.subscriptions.*\nSUBSCRIPTIONS_ENABLED\nSUBSCRIPTIONS_DEFAULT_PLAN]
    SubSvc --> ConfigBilling[config.billing.*\nBILLING_DEFAULT_CURRENCY]

    Schedule[WorkScheduleService\nupdateSchedule / markRunCompleted] --> SubSvc
    Schedule --> Ledger[UsageLedgerService.recordUsage]
    Ledger -->|short-circuit when disabled\nor billingMode != usage| Skip[(return null)]
    Ledger --> LedgerRepo[(usage_ledger_entries)]
    Ledger --> Provider[BillingProvider\n(default: ManualBillingProvider)\nrecordUsageCharge no-op]
```

## 2. Tech Choices

| Concern                      | Choice                                                                                                                     | Rationale                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP surface                 | NestJS controller `apps/api/src/subscriptions/subscriptions.controller.ts`                                                 | Same pattern as every other auth-guarded endpoint; SwaggerUI tags applied                                                                            |
| Auth                         | `AuthSessionGuard` (cookie or `ew_live_*` API key)                                                                         | Plan reads/writes always require an authenticated user                                                                                               |
| Validation                   | `class-validator` `@IsEnum(SubscriptionPlanCode)` on `UpdateSubscriptionPlanDto`                                           | Forces a closed-enum body; the validation pipe rejects unknown codes BEFORE the controller body                                                      |
| Plan catalog persistence     | `subscription_plans` (TypeORM `@Entity('subscription_plans')`) + `simple-json` for `allowedCadences`                       | Allows additive cadence values without a migration; `@Index(['code'], { unique: true })` enforces uniqueness                                         |
| Per-user link                | `users.defaultPlanId` FK + `user_subscriptions` (one active per user)                                                      | Two-tier model: `defaultPlan` is the "fallback when no active sub", `UserSubscription` is the active billing record                                  |
| Plan resolution precedence   | `getActiveSubscription` → `user.defaultPlan` → `resolveDefaultPlan` (config / FREE)                                        | Matches what the architecture spec describes; the four levels keep self-hosted, single-tenant, and SaaS branches all working with the same code path |
| Plan seeding                 | `onModuleInit` → `seedPlans` → `Promise.all(PLAN_SEED_DATA.map(upsert))`                                                   | Idempotent; runs on every boot; guarantees the catalog is always at the latest seed shape                                                            |
| Cadence allowance grid       | `ALL_CADENCES` (7 entries, ordered) projected with `Set` membership against `plan.allowedCadences`                         | The dashboard gets a stable seven-row response; `payPerUse: true` flag tells the UI which cadences require usage billing                             |
| Recommendation helper        | `recommendationForCadence(cadence)` switch                                                                                 | Maps each cadence to the suggested upgrade tier name; returned in the `reason` field                                                                 |
| Usage-ledger short-circuit   | Two early returns in `UsageLedgerService.recordUsage`: subscriptions-disabled OR billingMode != USAGE                      | Keeps subscription-mode runs free of any DB write                                                                                                    |
| Billing-provider abstraction | Abstract NestJS class `BillingProvider` + concrete `ManualBillingProvider`                                                 | Future Stripe / LemonSqueezy / Paddle implementations can extend without touching feature code                                                       |
| Currency                     | `config.billing.getDefaultCurrency()` via `ManualBillingProvider`                                                          | Single config knob (`BILLING_DEFAULT_CURRENCY`, default `'usd'`) drives every ledger row                                                             |
| Plan-limit gate              | `WorkScheduleService.updateSchedule` reads `scheduleRepository.countActiveByUser(user.id)` and compares to `plan.maxWorks` | Pre-flight gate that rejects with `PLAN_LIMIT_EXCEEDED` BEFORE the upsert                                                                            |
| Cadence gate                 | `WorkScheduleService.updateSchedule` calls `subscriptionService.requiresUsageBilling(cadence, plan, billingMode)`          | Single helper covers both "subscriptions disabled" and "cadence allowed" branches; throws `BadRequestException` when `true`                          |
| Post-completion accounting   | `WorkScheduleService.markRunCompleted` → `UsageLedgerService.recordUsage`                                                  | Single call site; failed/skipped runs do NOT call this so they are free                                                                              |

## 3. Data Model

```sql
-- subscription_plans (TypeORM entity: SubscriptionPlan)
CREATE TABLE subscription_plans (
    id uuid PRIMARY KEY,
    code varchar UNIQUE NOT NULL,             -- 'free' | 'standard' | 'premium'
    "displayName" varchar NOT NULL,
    "maxWorks" int NOT NULL DEFAULT 1,
    "allowedCadences" text NOT NULL,          -- simple-json array of WorkScheduleCadence
    "monthlyPrice" decimal(10,2) NOT NULL DEFAULT 0,
    "overagePricePerRun" decimal(10,2) NOT NULL DEFAULT 0,
    currency varchar NOT NULL DEFAULT 'usd',
    active boolean NOT NULL DEFAULT true,
    "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscription_plans_code_idx ON subscription_plans(code);
CREATE INDEX subscription_plans_active_idx ON subscription_plans(active);
```

```sql
-- user_subscriptions (TypeORM entity: UserSubscription)
CREATE TABLE user_subscriptions (
    id uuid PRIMARY KEY,
    "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "planCode" varchar NOT NULL,
    "planId" uuid REFERENCES subscription_plans(id),  -- eager-loaded
    status varchar NOT NULL DEFAULT 'active',         -- active | canceled | past_due | trialing
    "billingProvider" varchar NOT NULL DEFAULT 'stripe', -- stripe | manual
    "currentPeriodEnd" timestamp NULL,
    "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false,
    "paymentMethodMeta" json NULL,
    "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX user_subscriptions_user_status_idx ON user_subscriptions("userId", status);
CREATE INDEX user_subscriptions_plan_code_idx ON user_subscriptions("planCode");
```

```sql
-- usage_ledger_entries (TypeORM entity: UsageLedgerEntry)
CREATE TABLE usage_ledger_entries (
    id uuid PRIMARY KEY,
    "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "workId" uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    "scheduleId" uuid NULL REFERENCES work_schedules(id) ON DELETE SET NULL,
    "triggerType" varchar NOT NULL DEFAULT 'manual',     -- manual | scheduled
    "billingMode" varchar NOT NULL DEFAULT 'usage',      -- subscription | usage
    units int NOT NULL DEFAULT 1,
    "amountCents" int NOT NULL DEFAULT 0,
    currency varchar NOT NULL DEFAULT 'usd',
    status varchar NOT NULL DEFAULT 'pending',           -- pending | queued_for_settlement | paid | canceled
    "generationHistoryId" uuid NULL REFERENCES work_generation_histories(id),
    metadata json NULL,
    "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_user_status_idx  ON usage_ledger_entries("userId", status);
CREATE INDEX usage_ledger_work_idx         ON usage_ledger_entries("workId");
CREATE INDEX usage_ledger_created_at_idx   ON usage_ledger_entries("createdAt");
CREATE INDEX usage_ledger_schedule_idx     ON usage_ledger_entries("scheduleId");
```

## 4. Plan Seed Shape

`PLAN_SEED_DATA` (in `subscription.service.ts`, applied via
`SubscriptionPlanRepository.upsert` on every `onModuleInit`):

| `code`     | `displayName` | `maxWorks` | `allowedCadences`                                                                | `monthlyPrice` | `overagePricePerRun` |
| ---------- | ------------- | ---------- | -------------------------------------------------------------------------------- | -------------- | -------------------- |
| `free`     | `Free`        | `1`        | `ALL_CADENCES` _(temporary — see OQ-1; production gate is `[MONTHLY]`)_          | `'0'`          | `'10'`               |
| `standard` | `Standard`    | `5`        | `[MONTHLY, WEEKLY, DAILY, EVERY_12_HOURS]`                                       | `'29'`         | `'8'`                |
| `premium`  | `Premium`     | `15`       | `[MONTHLY, WEEKLY, DAILY, EVERY_12_HOURS, EVERY_8_HOURS, EVERY_3_HOURS, HOURLY]` | `'99'`         | `'0'`                |

`ALL_CADENCES` order (used by both the seed and `getCadenceAllowances`
projection): `MONTHLY, WEEKLY, DAILY, EVERY_12_HOURS, EVERY_8_HOURS,
EVERY_3_HOURS, HOURLY`.

## 5. HTTP Surface

| Method | Path                      | Guard              | Body                                 | Response                                                                                                                             |
| ------ | ------------------------- | ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/subscriptions/plan` | `AuthSessionGuard` | —                                    | `{ status: 'success', enabled: false, plan: null }` OR `{ status: 'success', enabled: true, plan: { code, name, allowedCadences } }` |
| POST   | `/api/subscriptions/plan` | `AuthSessionGuard` | `{ planCode: SubscriptionPlanCode }` | Same envelope as GET, with the new plan; throws 400 when subscriptions are disabled or the body fails `@IsEnum`.                     |

`POST` mutation order (controller `updatePlan`):

1. `subscriptionService.isEnabled()` — throw 400 if false (no further work).
2. `authService.getUser(auth.userId)` — resolves the in-memory `User`.
3. `subscriptionService.assignPlanToUser(user, dto.planCode)` — normalises the code, looks up the plan row (throws 404 on miss), updates `users.defaultPlanId`, mutates `user.defaultPlan` / `user.defaultPlanId` in place.
4. `subscriptionService.summarizePlan(user)` — recomputes the cadence allowance grid against the freshly-mutated user.
5. Return `{ status, enabled: true, plan: { code, name: plan.displayName, allowedCadences: summary.allowances } }`.

## 6. SubscriptionService Resolution Tree

```
resolvePlanForUser(user):
    if !isEnabled():
        return resolveDefaultPlan()              // configured default OR FREE OR throw
    sub = await getActiveSubscription(user.id)
    if sub?.plan: return sub.plan
    if user.defaultPlan: return user.defaultPlan
    return resolveDefaultPlan()

resolveDefaultPlan():
    code = normalizePlanCode(config.subscriptions.getDefaultPlanCode())  // env or 'free'
    plan = await planRepository.findByCode(code)
    if plan: return plan
    logger.warn(`Subscription plan ${code} not found, falling back to FREE`)
    fallback = await planRepository.findByCode(SubscriptionPlanCode.FREE)
    if !fallback: throw new Error('Default subscription plan not found')
    return fallback

normalizePlanCode(value):
    normalized = value?.toLowerCase()
    return normalized in SubscriptionPlanCode ? normalized : SubscriptionPlanCode.FREE

getCadenceAllowances(user):
    if !isEnabled():
        return ALL_CADENCES.map(c => ({ cadence: c, allowed: true, payPerUse: false }))
    plan = await resolvePlanForUser(user)
    set = new Set(plan.allowedCadences)
    return ALL_CADENCES.map(c => ({
        cadence: c,
        allowed: set.has(c),
        payPerUse: !set.has(c),
        reason: set.has(c) ? undefined : `Upgrade to ${recommendationForCadence(c)} for this cadence`,
    }))

requiresUsageBilling(cadence, plan, billingMode):
    if !isEnabled(): return false
    if plan.allowedCadences.includes(cadence): return false
    return billingMode !== WorkScheduleBillingMode.USAGE

getDefaultCadence(plan):
    return plan.allowedCadences.length ? last(plan.allowedCadences) : MONTHLY

assignPlanToUser(user, planCode):
    if !isEnabled(): throw new BadRequestException('Subscriptions are disabled')
    code = normalizePlanCode(planCode)
    plan = await planRepository.findByCode(code)
    if !plan: throw new NotFoundException('Plan not found')
    await userRepository.update(user.id, { defaultPlanId: plan.id })
    user.defaultPlan = plan; user.defaultPlanId = plan.id
    return plan
```

## 7. Usage-Ledger Recording

```
recordUsage({ userId, workId, schedule, triggerType, billingMode, generationHistoryId }):
    if !subscriptions.isEnabled() OR billingMode !== USAGE:
        return null
    amountCents = subscriptions.getPayPerUsePriceCents()  // max(0, round(USD * 100))
    entry = await ledgerRepository.record({
        userId,
        workId,
        scheduleId: schedule?.id,
        triggerType,
        billingMode,
        units: 1,
        amountCents,
        currency: billingProvider.getDefaultCurrency(),
        generationHistoryId,
        metadata: { cadence: schedule?.cadence },
    })
    await billingProvider.recordUsageCharge(entry)  // default: no-op
    return entry
```

The `ManualBillingProvider` is the registered token; future Stripe /
LemonSqueezy / Paddle implementations override `recordUsageCharge`.

## 8. Module Wiring

`packages/agent/src/subscriptions/subscriptions.module.ts`:

```ts
@Module({
	imports: [DatabaseModule],
	providers: [SubscriptionService, UsageLedgerService, { provide: BillingProvider, useClass: ManualBillingProvider }],
	exports: [SubscriptionService, UsageLedgerService, BillingProvider]
})
export class SubscriptionsModule {}
```

`apps/api/src/subscriptions/subscriptions.module.ts`:

```ts
@Module({
	imports: [AuthModule, AgentSubscriptionsModule],
	controllers: [SubscriptionsController]
})
export class SubscriptionsModule {}
```

`AppModule` imports `SubscriptionsModule`, ensuring
`SubscriptionService.onModuleInit()` runs on every boot.

## 9. Configuration Surface

| Knob                                                | Env var                                                    | Default       | Used by                                                          |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `config.subscriptions.isEnabled()`                  | `SUBSCRIPTIONS_ENABLED`                                    | `'false'`     | `SubscriptionService.isEnabled`, all gate functions              |
| `config.subscriptions.getDefaultPlanCode()`         | `SUBSCRIPTIONS_DEFAULT_PLAN`                               | `'free'`      | `resolveDefaultPlan`                                             |
| `config.subscriptions.getPayPerUsePriceCents()`     | `PAY_PER_USE_PRICE_USD` (parsed as USD then ×100, rounded) | `500` (cents) | `UsageLedgerService.recordUsage`                                 |
| `config.subscriptions.scheduledUpdatesEnabled()`    | `SCHEDULED_UPDATES_ENABLED`                                | `'true'`      | `WorkScheduleService` (separate scheduling toggle)               |
| `config.subscriptions.getMaxFailureBeforePause()`   | `SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE`               | `3`           | `WorkScheduleService` (auto-pause threshold)                     |
| `config.subscriptions.getDispatchIntervalMinutes()` | `SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES`              | `5`           | `WorkScheduleDispatcherCronService`                              |
| `config.subscriptions.getMaxBatch()`                | `SCHEDULED_UPDATES_MAX_BATCH`                              | `25`          | `WorkScheduleDispatcherCronService`                              |
| `config.billing.getDefaultCurrency()`               | `BILLING_DEFAULT_CURRENCY`                                 | `'usd'`       | `ManualBillingProvider`, `seedPlans`, ledger rows                |
| `config.billing.stripe.getSecretKey()`              | `STRIPE_SECRET_KEY`                                        | unset         | Reserved for the Stripe `BillingProvider` impl (not wired today) |
| `config.billing.stripe.getWebhookSecret()`          | `STRIPE_WEBHOOK_SECRET`                                    | unset         | Reserved for Stripe webhook verification                         |

## 10. Test Surface

| Layer      | File                                                                                 | What it pins                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller | `apps/api/src/subscriptions/subscriptions.controller.spec.ts` (9 tests, PR #496)     | `getPlan` enabled-false envelope, enabled mapping (`code/displayName` → `code/name + allowances`), `AuthService.getUser` + `summarizePlan` error propagation; `updatePlan` BadRequest when disabled (no `getUser` / `assignPlanToUser` side effects), happy-path mapping, plan envelope source = `assignPlanToUser` response, error propagation. |
| Service    | `packages/agent/src/subscriptions/__tests__/subscription.service.spec.ts` (existing) | `isEnabled` env coupling, `seedPlans` upsert calls, `resolvePlanForUser` four-level chain, `getCadenceAllowances` allowed/payPerUse projection, `requiresUsageBilling` truth table, `assignPlanToUser` enable/missing-plan/normalisation paths, default-plan fallback warn log.                                                                  |
| Service    | `packages/agent/src/subscriptions/__tests__/usage-ledger.service.spec.ts` (existing) | `recordUsage` short-circuits when subscriptions disabled, short-circuits when `billingMode !== USAGE`, writes a row with `units = 1` + `amountCents` from config, fans out to `billingProvider.recordUsageCharge`.                                                                                                                               |
| Consumer   | `packages/agent/src/services/__tests__/work-schedule.service.spec.ts` (existing)     | `updateSchedule` cadence gate via `requiresUsageBilling`, `PLAN_LIMIT_EXCEEDED` when `countActiveByUser >= plan.maxWorks`, `markRunCompleted` writes a ledger row, `markRunFailed` does NOT.                                                                                                                                                     |

Conventions follow `docs/specs/features/<feature>/spec.md` + `plan.md` +
`tasks.md` (Spec Kit), with the feature owner committing a PR that
checks these tests + updates `COVERAGE-TRACKER.md`.

## 11. Risks & Trade-offs

| Risk                                                                                 | Mitigation                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seedPlans` overwrites operator customisations on every boot                         | Operators are expected to fork `PLAN_SEED_DATA` if they need alternate seed shapes. The seed runs intentionally on every boot to keep the `displayName` / `maxWorks` / `allowedCadences` columns consistent with the code. |
| `assignPlanToUser` mutates the in-memory `User` reference                            | Documented in OQ-5; intentionally avoids a refetch in the controller's hot path. Callers should not hold an old reference past `assignPlanToUser`.                                                                         |
| `BillingProvider.recordUsageCharge` is awaited unguarded                             | Today the default impl is a no-op so this is invisible. Future Stripe impls should wrap their HTTP call in retry / circuit-breaker patterns and update the entry's `status` to `failed` for off-line settlement (OQ-3).    |
| `FREE` seed currently unlocks every cadence (`ALL_CADENCES` instead of `[MONTHLY]`)  | OQ-1; documented in §6 Out-of-Scope of `spec.md`. The unit suite pins the current behaviour so a re-tightening is a single-character flip + test update.                                                                   |
| `UserSubscription.billingProvider` defaults to `'stripe'` though Stripe is not wired | OQ-4; the column is reserved for the per-user provider when Stripe lands. The platform-side `BillingProvider` abstract class is independent of this value today.                                                           |
| No activity-log emission on plan change                                              | OQ-2; can be added later as a `SETTINGS_UPDATED` event. The controller is small enough that a single `.catch(() => {})` fire-and-forget log would suffice.                                                                 |

## 12. Migration & Forward-Only Schema

All three tables (`subscription_plans`, `user_subscriptions`,
`usage_ledger_entries`) are additive. New plan codes are added by:

1. Extending `SubscriptionPlanCode` enum in
   `packages/agent/src/entities/types.ts`.
2. Adding a row to `PLAN_SEED_DATA` in
   `packages/agent/src/subscriptions/subscription.service.ts`.
3. Extending `recommendationForCadence` to map the new tier name (only
   when adding a new cadence simultaneously).

New cadences are added by extending `WorkScheduleCadence` in
`@ever-works/contracts/api` and `ALL_CADENCES` in
`subscription.service.ts`. Existing rows continue to work because
`allowedCadences` is `simple-json` (not a closed enum at the DB layer).

## 13. References

- Architecture: [`docs/specs/architecture/subscriptions.md`](../../architecture/subscriptions.md)
- API reference: [`docs/api/subscriptions.md`](../../../api/subscriptions.md)
- Operator reference: [`docs/advanced/subscription-billing.md`](../../../advanced/subscription-billing.md)
- Module reference: [`docs/agent-services/subscriptions-module.md`](../../../agent-services/subscriptions-module.md)
