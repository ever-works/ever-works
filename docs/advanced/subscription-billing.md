---
id: subscription-billing
title: Subscription & Billing System
sidebar_label: Subscription & Billing
sidebar_position: 4
---

# Subscription & Billing System

The subscription system manages plan tiers, cadence allowances, and usage-based billing for the Ever Works platform. It is implemented in `packages/agent/src/subscriptions/`.

## Architecture

| Service               | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `SubscriptionService` | Plan resolution, cadence allowances, plan assignment   |
| `UsageLedgerService`  | Records per-run usage charges                          |
| `BillingProvider`     | Abstract billing gateway (extensible for Stripe, etc.) |

## Subscription Plans

Three plans are seeded on application startup via `OnModuleInit`:

| Plan     | Code       | Max Works | Allowed Cadences               | Monthly Price |
| -------- | ---------- | --------- | ------------------------------ | ------------- |
| Free     | `free`     | 1         | All (currently)                | $0            |
| Standard | `standard` | 5         | Monthly, Weekly, Daily         | $29           |
| Premium  | `premium`  | 15        | Monthly, Weekly, Daily, Hourly | $99           |

Each plan defines:

- **`maxWorks`** -- maximum number of works a user can create.
- **`allowedCadences`** -- which schedule cadences are included in the plan.
- **`monthlyPrice`** -- base monthly subscription cost.
- **`overagePricePerRun`** -- cost per generation run when using a cadence not included in the plan.

:::note
Currently, the Free plan allows all cadences for development purposes. In production, cadence restrictions will be enforced based on plan tier.
:::

### Plan Seed Data

Plans are upserted (created or updated) on every application start:

```typescript
async onModuleInit() {
    await this.seedPlans();
}
```

This ensures plan definitions stay in sync with the codebase across deployments.

## Plan Resolution

The `resolvePlanForUser(user)` method determines the active plan using this priority:

1. **Active subscription** -- if the user has a paid subscription via `UserSubscriptionRepository`, use that plan.
2. **Default plan** -- if the user has a `defaultPlan` assigned (e.g., through an admin override), use that.
3. **System default** -- fall back to the plan specified by `config.subscriptions.getDefaultPlanCode()`, which defaults to `free`.

If subscriptions are disabled globally (`config.subscriptions.isEnabled()` returns false), the system returns the default plan and allows all cadences without restrictions.

## Cadence Allowances

The `getCadenceAllowances(user)` method returns a list of all cadences with their availability:

```typescript
interface WorkScheduleAllowedCadence {
	cadence: WorkScheduleCadence;
	allowed: boolean;
	payPerUse: boolean;
	reason?: string;
}
```

For each cadence (Monthly, Weekly, Daily, Hourly):

- **`allowed: true`** -- cadence is included in the user's plan at no extra cost.
- **`payPerUse: true`** -- cadence is available but requires per-run usage billing.
- **`reason`** -- upgrade recommendation (e.g., "Upgrade to Premium for this cadence").

## Usage Ledger

The `UsageLedgerService` records individual usage charges when a generation run occurs outside the user's plan allowance.

### Recording Usage

```typescript
async recordUsage(options: RecordUsageOptions): Promise<UsageLedgerEntry | null>
```

Usage is recorded only when:

1. Subscriptions are globally enabled.
2. The schedule's `billingMode` is `USAGE` (pay-per-use).

Each ledger entry captures:

| Field                 | Description                                   |
| --------------------- | --------------------------------------------- |
| `userId`              | User who triggered the run                    |
| `workId`              | Work being generated                          |
| `scheduleId`          | Associated schedule (if applicable)           |
| `triggerType`         | How the run was triggered (manual, scheduled) |
| `billingMode`         | `USAGE` for pay-per-use runs                  |
| `units`               | Number of units (always 1 per run)            |
| `amountCents`         | Charge amount in cents                        |
| `currency`            | Currency code (from billing provider)         |
| `generationHistoryId` | Link to the generation history record         |
| `metadata`            | Additional context (cadence, etc.)            |

After recording the ledger entry, the charge is forwarded to the billing provider:

```typescript
await this.billingProvider.recordUsageCharge(entry);
```

## Billing Provider

The `BillingProvider` is an abstract class that defines the billing gateway interface:

```typescript
abstract class BillingProvider {
	abstract getDefaultCurrency(): string;
	async recordUsageCharge(_entry: UsageLedgerEntry): Promise<void> {
		return; // No-op by default
	}
}
```

### ManualBillingProvider

The default implementation (`ManualBillingProvider`) performs no external billing operations. It returns the configured default currency and treats `recordUsageCharge` as a no-op. This is suitable for self-hosted deployments or during development.

### Extending for Stripe

To integrate with Stripe (or another payment gateway), create a custom provider:

```typescript
@Injectable()
export class StripeBillingProvider extends BillingProvider {
	getDefaultCurrency(): string {
		return 'usd';
	}

	async recordUsageCharge(entry: UsageLedgerEntry): Promise<void> {
		// Forward the charge to Stripe's usage-based billing API
		await stripe.usageRecords.create(subscriptionItemId, {
			quantity: entry.units,
			timestamp: Math.floor(Date.now() / 1000)
		});
	}
}
```

## Feature Flags

| Config Key                                      | Purpose                                   |
| ----------------------------------------------- | ----------------------------------------- |
| `config.subscriptions.isEnabled()`              | Master toggle for the subscription system |
| `config.subscriptions.getDefaultPlanCode()`     | Default plan when no subscription exists  |
| `config.subscriptions.getPayPerUsePriceCents()` | Per-run overage charge in cents           |
| `config.billing.getDefaultCurrency()`           | Default currency code                     |

When subscriptions are disabled, all users get full access to all features with no billing.

## Plan Assignment

Administrators can assign a plan directly to a user:

```typescript
await subscriptionService.assignPlanToUser(user, SubscriptionPlanCode.STANDARD);
```

This updates the user's `defaultPlanId` field, which takes effect on the next plan resolution.

## Plan Summary

The `summarizePlan(user)` method returns a complete overview for display in the dashboard:

```typescript
const summary = await subscriptionService.summarizePlan(user);
// {
//     plan: { code: 'free', displayName: 'Free', ... },
//     allowances: [
//         { cadence: 'monthly', allowed: true, payPerUse: false },
//         { cadence: 'hourly', allowed: false, payPerUse: true, reason: '...' },
//     ],
//     enabled: true,
// }
```
