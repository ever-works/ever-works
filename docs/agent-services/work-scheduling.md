---
id: work-scheduling
title: Work Scheduling Service
sidebar_label: Work Scheduling
sidebar_position: 3
---

# Work Scheduling Service

The scheduling system enables automated, recurring generation runs for works. It consists of two services: `WorkScheduleService` (configuration and state management) and `WorkScheduleDispatcherService` (cron-like dispatch logic).

**Sources:**

- `packages/agent/src/services/work-schedule.service.ts`
- `packages/agent/src/services/work-schedule-dispatcher.service.ts`

## Overview

Scheduled updates allow works to automatically refresh their content at configurable intervals. The system integrates with the subscription/billing layer to enforce plan limits and supports both subscription-based and pay-per-use billing modes.

## Schedule Configuration

### Cadences

The system supports four cadence options, defined in `WorkScheduleCadence`:

| Cadence   | Interval       | Typical Use Case                |
| --------- | -------------- | ------------------------------- |
| `HOURLY`  | Every hour     | High-frequency monitoring works |
| `DAILY`   | Every 24 hours | Standard content refresh        |
| `WEEKLY`  | Every 7 days   | Low-frequency curated lists     |
| `MONTHLY` | Every 30 days  | Archival or slow-moving works   |

### Schedule Statuses

| Status     | Description                                               |
| ---------- | --------------------------------------------------------- |
| `ACTIVE`   | Schedule is running; `nextRunAt` is set                   |
| `PAUSED`   | Temporarily stopped (manual or auto-pause after failures) |
| `CANCELED` | Permanently stopped; configuration cleared                |
| `DISABLED` | Default state before any schedule is created              |

### Billing Modes

| Mode           | Description                                            |
| -------------- | ------------------------------------------------------ |
| `SUBSCRIPTION` | Runs count against the user's subscription plan limits |
| `USAGE`        | Pay-per-use billing; no plan cadence restrictions      |

## WorkScheduleService API

### Getting a Schedule

```typescript
const { schedule, workId } = await scheduleService.getSchedule(workId, user);
```

Returns a `WorkScheduleDto` containing current state, allowed cadences, and plan information. Any access level can view schedules.

### Creating or Updating a Schedule

```typescript
const schedule = await scheduleService.updateSchedule(
	workId,
	{
		enable: true,
		cadence: WorkScheduleCadence.DAILY,
		billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
		maxFailureBeforePause: 3,
		alwaysCreatePullRequest: false,
		providerOverrides: { ai: 'anthropic' }
	},
	user
);
```

The `updateSchedule` method performs extensive validation:

1. **Role check** -- Requires Editor or higher.
2. **Configuration readiness** -- Ensures the work has completed initial setup (has `last_request_data`). Sync works (with `sourceRepository`) skip this check.
3. **Plan limit enforcement** -- Checks `activeScheduleCount` against `plan.maxWorks`.
4. **Cadence validation** -- Verifies the cadence is allowed on the user's plan or in usage billing mode.
5. **Provider validation** -- Validates `providerOverrides` against the plugin registry.
6. **Failure threshold** -- `maxFailureBeforePause` must be between 1 and 10.

### Canceling a Schedule

```typescript
await scheduleService.cancelSchedule(workId, user);
```

Sets status to `CANCELED`, clears cadence, `nextRunAt`, and provider overrides.

### Pausing a Schedule

```typescript
await scheduleService.pauseSchedule(scheduleId);
```

Called internally when failure thresholds are reached or plan limits are exceeded.

## Run Lifecycle

### Dispatch Flow

The `WorkScheduleDispatcherService.dispatchDue()` method is the entry point, typically called from a cron job:

```typescript
const dispatched = await dispatcher.dispatchDue(limit);
```

The dispatch process:

1. **Recover stuck schedules** -- Finds schedules stuck in `GENERATING` state for over 1 hour and marks them as failed.
2. **Find due schedules** -- Queries `scheduleRepository.findDue(limit)` for active schedules where `nextRunAt <= now`.
3. **Reserve each schedule** -- Calls `markRunDispatched()` which uses an atomic update to prevent double-dispatch.
4. **Execute generation** -- Calls `workGenerationService.runScheduledUpdate()`.
5. **Handle failures** -- On error, marks the schedule as failed via `markRunFailed()`.

### Run Completion

When a generation completes successfully:

```typescript
await scheduleService.markRunCompleted({
	scheduleId,
	historyId,
	status: GenerateStatusType.GENERATED
});
```

This method:

- Calculates the next run time based on the **intended execution time** (not completion time) to prevent schedule drift.
- Compensates for retry delays when recovering from previous failures.
- Resets the failure counter to zero.
- Records usage in the billing ledger.

### Run Failure

```typescript
await scheduleService.markRunFailed(scheduleId, 'API rate limit exceeded');
```

Failure handling:

- Increments `failureCount`.
- If `failureCount >= maxFailureBeforePause`, the schedule is paused and a notification is sent.
- Otherwise, sets `nextRunAt` to `anchor + RETRY_DELAY_MINUTES` (default: 15 minutes).

### Drift Prevention

The scheduling system prevents time drift through anchor-based calculation:

```typescript
calculateNextRun(cadence: WorkScheduleCadence, delayMinutes = 0, fromDate = new Date()): Date
```

- On **success**, the next run is calculated from the original `nextRunAt` (not `Date.now()`).
- On **failure recovery**, retry delay compensation is subtracted to preserve the original anchor.
- A 24-hour safety window prevents using very old anchors.

## Entitlement Validation

Before each scheduled run, `validateRunEntitlement()` checks:

1. **Plan limits** -- If `activeScheduleCount > plan.maxWorks`, the schedule is paused.
2. **Cadence allowance** -- If the cadence is no longer allowed on the user's plan, the schedule is paused.
3. **Pay-per-use bypass** -- Usage billing mode skips plan limit checks.

This is a "lazy enforcement" model that catches plan downgrades at execution time rather than requiring a separate reconciliation job.

## Work Synchronization

Schedule state changes are synced back to the work entity via `syncWork()`:

```typescript
await workRepository.update(workId, {
	scheduledUpdatesEnabled: true,
	scheduledCadence: 'daily',
	scheduledNextRunAt: nextRunDate,
	scheduledStatus: 'active'
});
```

This denormalization allows the frontend to display schedule status without a separate query.

## Configuration

The scheduling system reads configuration from the agent config module:

| Config Key                | Environment Variable                          | Default | Description                          |
| ------------------------- | --------------------------------------------- | ------- | ------------------------------------ |
| `scheduledUpdatesEnabled` | `SCHEDULED_UPDATES_ENABLED`                   | `true`  | Master toggle for scheduling         |
| `dispatchIntervalMinutes` | `SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES` | `5`     | Cron dispatch frequency              |
| `maxBatch`                | `SCHEDULED_UPDATES_MAX_BATCH`                 | `25`    | Max schedules processed per dispatch |
| `maxFailureBeforePause`   | `SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE`  | `3`     | Default failure threshold            |

When `SCHEDULED_UPDATES_ENABLED` is `false`, all schedule operations throw a `BadRequestException`.
