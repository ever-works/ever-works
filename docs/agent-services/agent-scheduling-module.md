---
id: agent-scheduling-module
title: Scheduling Module
sidebar_label: Scheduling
sidebar_position: 29
---

# Scheduling Module

## Overview

The Scheduling module in `@ever-works/agent` manages automated, recurring updates for works. It provides cadence-based scheduling (hourly, daily, weekly, monthly), integrates with the subscription/billing system for plan enforcement, handles failure recovery with configurable retry limits, and implements drift-correction to maintain consistent execution timing.

The scheduler is designed to work with the Trigger.dev background job system -- it manages schedule state and entitlements while the actual execution dispatch happens through the `WorkGenerationDispatcher` interface.

## Module Structure

```
packages/agent/src/
  services/
    work-schedule.service.ts    # Core scheduling service (~571 lines)
    work.module.ts              # Registered as part of WorkModule
  entities/
    work.entity.ts              # Schedule fields on Work entity
    work-schedule.entity.ts     # WorkSchedule entity (1:1 with Work)
    types.ts                         # WorkScheduleCadence, WorkScheduleStatus
  subscriptions/
    subscription.service.ts          # Plan enforcement for scheduling
  tasks/
    work-generation-dispatcher.ts   # Dispatcher interface
    work-generation.types.ts        # Dispatch payload types
```

## Key Classes and Services

### `WorkScheduleService`

The core service (~571 lines) managing all scheduling operations:

**Schedule management:**

- **`getSchedule(workId)`** -- retrieve the current schedule configuration and status
- **`updateSchedule(work, user, cadence, options)`** -- enable or update the schedule. Validates entitlements, calculates next run time, and persists the schedule.
- **`cancelSchedule(work, user)`** -- disable scheduling entirely. Clears the cadence, next run time, and resets status.
- **`pauseSchedule(work, user, reason?)`** -- temporarily pause without losing configuration. The cadence is preserved but no runs will be dispatched.

**Run lifecycle:**

- **`markRunDispatched(workId)`** -- mark that a scheduled run has been sent to the background worker
- **`markRunCompleted(workId)`** -- mark successful completion. Calculates the next run time using drift correction.
- **`markRunFailed(workId, error)`** -- record a failure. Increments the failure counter and potentially auto-pauses the schedule.

**Recovery:**

- **`recoverStuckSchedules()`** -- find schedules that have been in "dispatched" status for too long and reset them for retry. This handles cases where the background worker crashed or timed out.
- **`validateRunEntitlement(work, user)`** -- check that the user's subscription plan allows the scheduled run to proceed.

### Cadence System

Four cadence levels are supported:

| Cadence   | Interval         | Typical Use Case                      |
| --------- | ---------------- | ------------------------------------- |
| `HOURLY`  | Every 60 minutes | High-frequency monitoring works |
| `DAILY`   | Every 24 hours   | Standard content works          |
| `WEEKLY`  | Every 7 days     | Slower-moving curated lists           |
| `MONTHLY` | Every 30 days    | Archival or low-update works    |

### Drift Correction

The scheduler calculates the next run time based on the **intended** execution time, not the actual completion time. This prevents gradual time drift:

```
Intended: 08:00 daily
Actual completion: 08:07
Next run: 08:00 tomorrow (not 08:07 tomorrow)
```

If the calculated next time is already in the past (e.g., the run took longer than the interval), the scheduler skips forward to the next valid slot.

### Failure Handling

The service implements configurable failure limits:

- **`maxFailureBeforePause`** -- configurable per schedule (1-10, default: 3)
- On each failure, the failure counter increments
- When the counter reaches the limit, the schedule is automatically paused
- A 15-minute retry delay is added after each failure before the next attempt
- Failures are recorded with error messages for diagnostics

### Billing Integration

Two billing modes are supported:

| Mode           | Behavior                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------- |
| `SUBSCRIPTION` | Schedule runs are included in the subscription plan. Cadence options are gated by plan tier. |
| `USAGE`        | Pay-per-use billing. Each run is metered and billed separately.                              |

Plan enforcement validates:

- Allowed cadence levels per subscription tier
- Maximum number of works with active schedules
- Per-run entitlement check before dispatch

## API Reference

### WorkScheduleService

```typescript
// Schedule management
getSchedule(workId: string): Promise<ScheduleInfo>

updateSchedule(
    work: Work,
    user: User,
    cadence: WorkScheduleCadence,
    options?: {
        maxFailureBeforePause?: number;  // 1-10, default: 3
        startAt?: Date;                  // When to begin (default: now + interval)
    }
): Promise<ScheduleInfo>

cancelSchedule(work: Work, user: User): Promise<void>
pauseSchedule(work: Work, user: User, reason?: string): Promise<void>

// Run lifecycle
markRunDispatched(workId: string): Promise<void>
markRunCompleted(workId: string): Promise<void>
markRunFailed(workId: string, error: string): Promise<void>

// Recovery and validation
recoverStuckSchedules(): Promise<number>  // Returns count of recovered schedules
validateRunEntitlement(work: Work, user: User): Promise<{
    allowed: boolean;
    reason?: string;
}>
```

### ScheduleInfo

```typescript
interface ScheduleInfo {
	enabled: boolean;
	cadence: WorkScheduleCadence | null;
	status: WorkScheduleStatus | null;
	nextRunAt: Date | null;
	lastRunAt?: Date;
	lastError?: string;
	failureCount: number;
	maxFailureBeforePause: number;
}
```

### WorkScheduleCadence

```typescript
type WorkScheduleCadence = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
```

### WorkScheduleStatus

```typescript
type WorkScheduleStatus = 'active' | 'paused' | 'dispatched' | 'running' | 'error';
```

## Configuration

### Work Entity Schedule Fields

The `Work` entity carries inline schedule fields for quick-access:

```typescript
@Column({ type: 'boolean', default: false })
scheduledUpdatesEnabled: boolean;

@Column({ type: 'varchar', nullable: true })
scheduledCadence?: WorkScheduleCadence | null;

@TimestampColumn({ nullable: true })
scheduledNextRunAt?: Date | null;

@Column({ type: 'varchar', nullable: true })
scheduledStatus?: WorkScheduleStatus | null;
```

### WorkSchedule Entity

The `WorkSchedule` entity (one-to-one with Work) stores extended scheduling metadata:

- `failureCount` -- current consecutive failure count
- `maxFailureBeforePause` -- threshold for auto-pause
- `lastRunAt` / `lastError` -- most recent run information
- `pausedReason` -- reason for pause (if paused)
- `billingMode` -- `SUBSCRIPTION` or `USAGE`

### Dispatch Integration

Scheduled runs are dispatched through the `WorkGenerationDispatcher` interface:

```typescript
interface WorkGenerationDispatcher {
	dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null>;
}

interface WorkGenerationPayload {
	workId: string;
	userId: string;
	options?: {
		aiProviderOverride?: string;
	};
}
```

The dispatcher is injected via the `DIRECTORY_GENERATION_DISPATCHER` Symbol token, decoupling the scheduling logic from the specific background job implementation (Trigger.dev).

## Dependencies

| Dependency                        | Purpose                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `@ever-works/agent/database`      | `WorkRepository`, `WorkScheduleRepository`      |
| `@ever-works/agent/subscriptions` | Plan enforcement and billing mode resolution              |
| `@ever-works/agent/tasks`         | `DIRECTORY_GENERATION_DISPATCHER` for background dispatch |
| `TypeORM`                         | Entity persistence and queries                            |

## Usage Examples

### Enabling a Daily Schedule

```typescript
import { WorkScheduleService } from '@ever-works/agent/services';

const schedule = await scheduleService.updateSchedule(work, user, 'DAILY', { maxFailureBeforePause: 5 });

console.log(`Next run at: ${schedule.nextRunAt}`);
```

### Handling Run Completion

```typescript
// Called by the background worker after successful generation
await scheduleService.markRunCompleted(workId);
// Next run time is calculated with drift correction

// On failure
await scheduleService.markRunFailed(workId, 'AI provider rate limit exceeded');
// Auto-pauses after maxFailureBeforePause consecutive failures
```

### Recovering Stuck Schedules

```typescript
// Run periodically (e.g., every 30 minutes) to recover orphaned runs
const recovered = await scheduleService.recoverStuckSchedules();
console.log(`Recovered ${recovered} stuck schedules`);
```

### Checking Entitlements

```typescript
const { allowed, reason } = await scheduleService.validateRunEntitlement(work, user);
if (!allowed) {
	console.log(`Schedule blocked: ${reason}`);
	// e.g., "Plan does not allow HOURLY cadence"
}
```
