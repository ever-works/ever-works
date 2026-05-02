# Architecture: Subscriptions & Usage Billing

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers wiring billable operations,
debugging plan limits, or extending billing providers.

---

## 1. Purpose

Every billable platform operation flows through one of two billing
modes — **subscription** (counts against the user's plan quota) or
**usage** (pay-per-use, recorded in a usage ledger and charged through
the billing provider). This spec covers the **plan model**, the
**usage ledger**, the **billing-provider abstraction**, and how
features (scheduled updates, generation runs, comparisons) plug into
the billing surface without owning Stripe integration code.

The canonical entry points are `SubscriptionService` (plan + entitlement
checks) and `UsageLedgerService` (usage recording + billing-provider
fan-out).

## 2. Module Layout

```
apps/api/src/subscriptions/
├── subscriptions.controller.ts     # /api/subscriptions/* HTTP surface
└── subscriptions.module.ts         # Wires everything together

packages/agent/src/subscriptions/
├── subscription.service.ts         # Plan + entitlement resolution
├── usage-ledger.service.ts         # Records UsageLedgerEntry, fans out to billing
├── subscriptions.module.ts         # Registers in the agent package
├── billing/
│   └── billing.provider.ts         # Abstract interface + Stripe impl token
└── index.ts
```

The split is deliberate: HTTP concerns live in `apps/api`, domain
logic in `packages/agent` so other entry points (Trigger.dev tasks,
internal CLI) can call the same services without going through HTTP.

## 3. Plan Model

| Plan tier      | What it gates                                              | Stripe price id source |
| -------------- | ---------------------------------------------------------- | ---------------------- |
| **Free**       | Default tier; limited active directories, limited cadences | None (no Stripe)       |
| **Pro**        | More directories, faster cadences, Agent Pipeline          | `STRIPE_PRICE_PRO_*`   |
| **Team**       | Everything in Pro + members + custom domains               | `STRIPE_PRICE_TEAM_*`  |
| **Enterprise** | Custom contracts (handled out-of-band)                     | None (manual)          |

Each plan exposes machine-readable limits (`maxDirectories`,
`maxScheduledDirectories`, `allowedCadences`, etc.). The platform
reads these via `config.subscriptions.*` so changes to plan shape are
config-only — not a code change.

When `subscriptionsEnabled = false` (single-tenant or self-hosted
deploys), the entire system short-circuits to "everything allowed" —
see §10.

## 4. The Two Billing Modes

Every billable operation carries a `DirectoryScheduleBillingMode`:

| Mode           | Behaviour                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `subscription` | Counts against plan quota. If the action would exceed quota, it's rejected up-front with `400`.     |
| `usage`        | Pay-per-use. The action proceeds and writes a `UsageLedgerEntry` that the billing provider charges. |

The mode is a **per-resource setting** (per-schedule today; potentially
per-directory in future). Users on an Enterprise plan typically run
everything in `subscription` mode against a custom contract; Pro users
mix-and-match — they keep their daily directories on `subscription`
and switch experimental hourly directories to `usage` to bypass plan
limits.

## 5. The Usage Ledger

`UsageLedgerEntry` rows track every billable usage event:

```ts
@Entity('usage_ledger_entries')
export class UsageLedgerEntry {
	@PrimaryGeneratedColumn('uuid') id: string;
	@Column() userId: string;
	@Column({ nullable: true }) directoryId: string | null;
	@Column({ type: 'varchar' }) triggerType: UsageLedgerTriggerType;
	@Column({ type: 'varchar' }) billingMode: DirectoryScheduleBillingMode;
	@Column({ nullable: true }) generationHistoryId: string | null;
	@Column({ type: 'varchar' }) status: UsageLedgerStatus;
	@Column({ nullable: true }) chargeReference: string | null; // Stripe charge id
	@CreateDateColumn() createdAt: Date;
}
```

`UsageLedgerTriggerType` values (today):

- `SCHEDULED` — scheduled update completed
- `MANUAL_GENERATION` — user-triggered generation
- `COMPARISON_GENERATED` — A vs B comparison page produced
- `IMPORT_AWESOME` — Awesome README import completed

`UsageLedgerService.recordUsage(options)` is the single entry point:

```ts
const entry = await usageLedgerService.recordUsage({
	userId,
	directoryId: schedule.directoryId,
	schedule,
	triggerType: UsageLedgerTriggerType.SCHEDULED,
	billingMode: schedule.billingMode,
	generationHistoryId
});
```

The service:

1. **Short-circuits** if subscriptions are disabled or
   `billingMode !== USAGE` (returns `null` — no row written).
2. Inserts a `pending` ledger entry.
3. Calls `billingProvider.recordUsageCharge(entry)`.
4. Updates the entry to `charged` (or `failed`) based on the provider's
   response.
5. Returns the entry.

A failed billing-provider call doesn't roll back the underlying
operation. The user got their work done; the platform just owes
itself a retry on the ledger entry. A separate Trigger.dev task
periodically retries `failed` entries.

## 6. The `BillingProvider` Abstraction

The `BillingProvider` interface lives at
`packages/agent/src/subscriptions/billing/billing.provider.ts`:

```ts
export interface BillingProvider {
	// Plans & subscriptions
	getPlanForUser(userId: string): Promise<UserPlan>;
	createCheckoutSession(userId: string, priceId: string): Promise<{ url: string }>;
	cancelSubscription(userId: string): Promise<void>;
	listInvoices(userId: string): Promise<Invoice[]>;

	// Usage charges
	recordUsageCharge(entry: UsageLedgerEntry): Promise<{
		chargeReference?: string;
		status: 'charged' | 'failed' | 'skipped';
	}>;

	// Webhook handling
	handleWebhook(req: WebhookRequest): Promise<WebhookResult>;
}
```

The default implementation wraps Stripe via the `stripe` Node SDK. The
abstraction means a future deploy could swap to a different provider
(LemonSqueezy, Paddle, etc.) without touching feature code.

When `subscriptionsEnabled = false`, a `NullBillingProvider`
implementation is registered: every method either returns a "no plan"
result or no-ops. Features that branch on plan limits all see the
"everything allowed" answer.

## 7. Plan-Gating Patterns

Two ways features check plan limits:

### 7.1 Pre-flight check

Used for actions where rejecting up-front is cheap. Example:
activating a hourly schedule on a plan that doesn't allow hourly.

```ts
const ok = await subscriptionService.validateRunEntitlement(schedule, user);
if (!ok) throw new BadRequestException('Cadence not allowed on this plan');
```

`validateRunEntitlement` consults the plan's `allowedCadences` and the
schedule's `billingMode`. It always returns `true` when subscriptions
are disabled, when the schedule is in `usage` mode (any cadence
allowed), or when the user's plan permits the cadence.

### 7.2 Post-completion accounting

Used for events where you only know the cost after the work is done
(generation cost, item count). Always backed by a `UsageLedgerEntry`
write inside the same transaction as the operation's
finalisation. See `markRunCompleted` on `DirectoryScheduleService` for
the canonical example.

## 8. Webhooks

`SubscriptionsController` exposes `POST /api/subscriptions/webhook`
which forwards verified Stripe webhook events to
`billingProvider.handleWebhook`. Critical events:

| Stripe event                    | Effect                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| `customer.subscription.created` | Activate the user's plan                                   |
| `customer.subscription.updated` | Update plan tier; possibly downgrade                       |
| `customer.subscription.deleted` | Mark plan as cancelled (kept until `cancel_at_period_end`) |
| `invoice.payment_succeeded`     | Mark linked usage ledger entries as `charged`              |
| `invoice.payment_failed`        | Mark plan as `payment_failing`; surface dashboard banner   |
| `charge.dispute.created`        | Pause the user's account until resolved                    |

Webhook signature verification uses the Stripe SDK's
`constructEvent(body, signature, secret)` — never trust an unverified
payload.

## 9. Schedule-Specific Billing Notes

`DirectoryScheduleService` is the most active billing consumer.
Specific behaviours:

- `markRunCompleted` always records a usage entry (no-op when not in
  usage mode).
- `markRunFailed` does **not** record usage — failed runs are free.
- Cadence changes are pre-flight checked against the plan; switching
  a directory from `monthly` (allowed on plan) to `hourly` (not
  allowed) requires either a plan upgrade or `billingMode: usage`.
- Pay-per-use schedules can override plan limits via the
  `payPerUse: true` flag in `allowedCadences[]` per cadence — the
  schedule UI shows the price the user will pay.

See [`features/scheduled-updates/spec`](../features/scheduled-updates/spec.md)
for the user-facing behaviour the billing layer enforces.

## 10. The `subscriptionsEnabled` Switch

`config.subscriptions.scheduledUpdatesEnabled()` and
`config.subscriptions.isEnabled()` are the two top-level flags. When
**either** is off, the platform behaves as if everything is unlimited:

- `validateRunEntitlement` always returns `true`.
- `recordUsage` returns `null` without writing.
- `BillingProvider` is the `NullBillingProvider`.
- Schedule UI hides plan-tier hints.
- Webhook endpoint returns `204` without processing.

This is the self-hosted / single-tenant / on-prem mode — the platform
ships with billing turned off by default. Operators flip the env var
when they're ready to wire Stripe.

## 11. Limits Surface

`SubscriptionService.getLimits(userId)` returns a typed `PlanLimits`
object the dashboard consumes for plan-aware UI:

```ts
interface PlanLimits {
	maxDirectories: number | null; // null = unlimited
	maxScheduledDirectories: number | null;
	allowedCadences: Array<{
		cadence: DirectoryScheduleCadence;
		allowed: boolean;
		payPerUse?: boolean;
		reason?: string; // human-readable upgrade hint
	}>;
	canInviteMembers: boolean;
	canUseCustomDomains: boolean;
	canUseAgentPipeline: boolean;
	monthlyUsageRemaining: number | null;
}
```

The dashboard renders feature toggles greyed out when the user's plan
doesn't permit them, and uses `reason` for the tooltip ("Upgrade to
Pro for hourly cadence").

## 12. Constitution Reconciliation

| Principle                   | How subscriptions respects it                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| I — Plugin-first            | The `BillingProvider` is interface-first; Stripe is one impl, others can plug.                           |
| II — Capability-driven      | Billing isn't a plugin capability today — it's a single-instance abstraction.                            |
| III — Source-of-truth repos | Billing data is platform-side; not in user repos.                                                        |
| IV — Trigger.dev            | Failed-charge retries run as Trigger.dev tasks.                                                          |
| V — Forward-only migrations | `usage_ledger_entries` and plan tables additive.                                                         |
| VI — Tests                  | `subscription.service.spec.ts` + `usage-ledger.service.spec.ts` cover both modes plus the disabled path. |
| VII — Secret hygiene        | Stripe secret key + webhook secret in encrypted env-var store; never logged.                             |
| VIII — Plugin counts        | N/A.                                                                                                     |
| IX — Behaviour-first        | This spec describes observable billing behaviour.                                                        |
| X — Backwards-compat        | New `triggerType` values are additive; `subscriptionsEnabled = false` default keeps single-tenant clean. |

## 13. References

- Source:
    - `apps/api/src/subscriptions/`
    - `packages/agent/src/subscriptions/`
    - `packages/agent/src/entities/usage-ledger-entry.entity.ts`
- Related specs:
    - [`features/scheduled-updates/spec`](../features/scheduled-updates/spec.md)
    - [`features/comparisons/spec`](../features/comparisons/spec.md)
    - [`features/custom-domains/spec`](../features/custom-domains/spec.md)
- User docs: [`docs/api/subscriptions.md`](../../api/subscriptions.md)
