---
id: subscriptions
title: Subscriptions & Billing API
sidebar_label: Subscriptions
sidebar_position: 7
---

# Subscriptions & Billing API

The subscriptions module manages plan tiers, cadence allowances, usage-based billing, and plan assignment for users. It is split across two layers: the **API controller** (`apps/api/src/subscriptions/`) exposes REST endpoints, while the **agent package** (`packages/agent/src/subscriptions/`) contains core business logic, plan seeding, and the billing provider abstraction.

## Architecture Overview

```
apps/api/src/subscriptions/
  subscriptions.controller.ts   # REST endpoints (GET/POST /api/subscriptions/plan)
  subscriptions.module.ts       # NestJS module wiring

packages/agent/src/subscriptions/
  subscription.service.ts       # Plan resolution, cadence allowances, plan assignment
  usage-ledger.service.ts       # Pay-per-use tracking and billing provider integration
  billing/
    billing.provider.ts         # Abstract billing provider + ManualBillingProvider
  subscriptions.module.ts       # Agent-level module
  index.ts                      # Public barrel exports
```

## Subscription Plans

Plans are seeded automatically on module initialization via `SubscriptionService.onModuleInit()`. Three tiers are defined:

| Plan         | Code       | Max Works | Allowed Cadences                  | Monthly Price | Overage/Run |
| ------------ | ---------- | --------- | --------------------------------- | ------------- | ----------- |
| **Free**     | `free`     | 1         | Monthly, Weekly, Daily, Hourly \* | $0            | $10         |
| **Standard** | `standard` | 5         | Monthly, Weekly, Daily            | $29           | $8          |
| **Premium**  | `premium`  | 15        | Monthly, Weekly, Daily, Hourly    | $99           | $0          |

> \* Currently all cadences are enabled for the Free plan during the early-access period.

Each plan is stored as a `SubscriptionPlan` entity with fields: `code`, `displayName`, `maxWorks`, `allowedCadences`, `monthlyPrice`, `overagePricePerRun`, `currency`, and `active`.

## REST Endpoints

All endpoints require JWT authentication (`@UseGuards(JwtAuthGuard)`).

### GET `/api/subscriptions/plan`

Retrieve the current user's subscription plan and cadence allowances.

**Response (subscriptions enabled):**

```json
{
	"status": "success",
	"enabled": true,
	"plan": {
		"code": "free",
		"name": "Free",
		"allowedCadences": [
			{ "cadence": "monthly", "allowed": true, "payPerUse": false },
			{ "cadence": "weekly", "allowed": true, "payPerUse": false },
			{ "cadence": "daily", "allowed": true, "payPerUse": false },
			{ "cadence": "hourly", "allowed": true, "payPerUse": false }
		]
	}
}
```

**Response (subscriptions disabled):**

```json
{
	"status": "success",
	"enabled": false,
	"plan": null
}
```

### POST `/api/subscriptions/plan`

Update the user's subscription plan.

**Request body:**

```json
{
	"planCode": "standard"
}
```

Valid values for `planCode`: `free`, `standard`, `premium` (validated via `SubscriptionPlanCode` enum).

**Response:**

```json
{
  "status": "success",
  "enabled": true,
  "plan": {
    "code": "standard",
    "name": "Standard",
    "allowedCadences": [...]
  }
}
```

Returns `400 Bad Request` if subscriptions are disabled.

## SubscriptionService

The core service in `packages/agent/src/subscriptions/subscription.service.ts` provides:

| Method                         | Description                                                            |
| ------------------------------ | ---------------------------------------------------------------------- |
| `isEnabled()`                  | Checks the global `config.subscriptions.isEnabled()` flag              |
| `resolvePlanForUser(user)`     | Returns the active plan: subscription > user default > global default  |
| `getCadenceAllowances(user)`   | Returns all cadences with `allowed`, `payPerUse`, and upgrade `reason` |
| `assignPlanToUser(user, code)` | Sets the user's `defaultPlanId` to the matching plan                   |
| `summarizePlan(user)`          | Combines plan + allowances + enabled flag into one response            |
| `requiresUsageBilling()`       | Determines if a cadence/plan combo requires pay-per-use billing        |
| `getDefaultCadence(plan)`      | Returns the highest-frequency cadence allowed by the plan              |
| `seedPlans()`                  | Upserts all plan definitions on startup                                |

### Plan Resolution Order

1. Active `UserSubscription` (if one exists)
2. User's `defaultPlan` field
3. Global default from `config.subscriptions.getDefaultPlanCode()`
4. Fallback to `FREE`

## Usage Ledger Service

`UsageLedgerService` records pay-per-use charges when a work generation runs on a cadence not included in the user's plan.

```typescript
await usageLedgerService.recordUsage({
	userId: 'user-123',
	workId: 'dir-456',
	schedule: workSchedule,
	triggerType: UsageLedgerTriggerType.SCHEDULED,
	billingMode: WorkScheduleBillingMode.USAGE,
	generationHistoryId: 'gen-789'
});
```

The service:

1. Checks if subscriptions are enabled and billing mode is `USAGE`
2. Reads the per-use price from `config.subscriptions.getPayPerUsePriceCents()`
3. Records an entry in the `UsageLedgerRepository`
4. Calls `billingProvider.recordUsageCharge(entry)` for external gateway forwarding

## Billing Provider

The `BillingProvider` is an abstract class with two methods:

| Method                     | Description                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `getDefaultCurrency()`     | Returns the default currency string (e.g., `"usd"`)               |
| `recordUsageCharge(entry)` | Optional hook for forwarding charges to Stripe or another gateway |

The default `ManualBillingProvider` reads the currency from `config.billing.getDefaultCurrency()` and does not forward charges externally. To integrate Stripe or another payment gateway, extend `BillingProvider` and override `recordUsageCharge()`.

## Configuration

The subscriptions system reads from the application config:

| Config Key                                      | Description                               |
| ----------------------------------------------- | ----------------------------------------- |
| `config.subscriptions.isEnabled()`              | Master toggle for the subscription system |
| `config.subscriptions.getDefaultPlanCode()`     | Default plan code for new users           |
| `config.subscriptions.getPayPerUsePriceCents()` | Cost per overage run in cents             |
| `config.billing.getDefaultCurrency()`           | Currency for all billing operations       |

## Module Registration

The API module imports `AgentSubscriptionsModule` and `AuthModule`:

```typescript
@Module({
	imports: [AuthModule, AgentSubscriptionsModule],
	controllers: [SubscriptionsController]
})
export class SubscriptionsModule {}
```

The agent-level `SubscriptionsModule` provides `SubscriptionService`, `UsageLedgerService`, and `BillingProvider` to any consumer.
