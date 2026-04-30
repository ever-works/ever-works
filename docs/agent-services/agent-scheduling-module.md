---
id: agent-scheduling-module
title: Scheduling Module
sidebar_label: Scheduling
sidebar_position: 29
---

# Scheduling Module

## Overview

The Scheduling module in `@ever-works/agent` manages automated, recurring updates for directories. It provides cadence-based scheduling (hourly, daily, weekly, monthly), integrates with the subscription/billing system for plan enforcement, handles failure recovery with configurable retry limits, and implements drift-correction to maintain consistent execution timing.

The scheduler is designed to work with the Trigger.dev background job system -- it manages schedule state and entitlements while the actual execution dispatch happens through the `DirectoryGenerationDispatcher` interface.

## Module Structure

```
packages/agent/src/
  services/
    directory-schedule.service.ts    # Core scheduling service (~571 lines)
    directory.module.ts              # Registered as part of DirectoryModule
  entities/
    directory.entity.ts              # Schedule fields on Directory entity
    directory-schedule.entity.ts     # DirectorySchedule entity (1:1 with Directory)
    types.ts                         # DirectoryScheduleCadence, DirectoryScheduleStatus
  subscriptions/
    subscription.service.ts          # Plan enforcement for scheduling
  tasks/
    directory-generation-dispatcher.ts   # Dispatcher interface
    directory-generation.types.ts        # Dispatch payload types
```

## Key Classes and Services

### `DirectoryScheduleService`

The core service (~571 lines) managing all scheduling operations:

**Schedule management:**

- **`getSchedule(directoryId)`** -- retrieve the current schedule configuration and status
- **`updateSchedule(directory, user, cadence, options)`** -- enable or update the schedule. Validates entitlements, calculates next run time, and persists the schedule.
- **`cancelSchedule(directory, user)`** -- disable scheduling entirely. Clears the cadence, next run time, and resets status.
- **`pauseSchedule(directory, user, reason?)`** -- temporarily pause without losing configuration. The cadence is preserved but no runs will be dispatched.

**Run lifecycle:**

- **`markRunDispatched(directoryId)`** -- mark that a scheduled run has been sent to the background worker
- **`markRunCompleted(directoryId)`** -- mark successful completion. Calculates the next run time using drift correction.
- **`markRunFailed(directoryId, error)`** -- record a failure. Increments the failure counter and potentially auto-pauses the schedule.

**Recovery:**

- **`recoverStuckSchedules()`** -- find schedules that have been in "dispatched" status for too long and reset them for retry. This handles cases where the background worker crashed or timed out.
- **`validateRunEntitlement(directory, user)`** -- check that the user's subscription plan allows the scheduled run to proceed.

### Cadence System

Four cadence levels are supported:

| Cadence   | Interval         | Typical Use Case                      |
| --------- | ---------------- | ------------------------------------- |
| `HOURLY`  | Every 60 minutes | High-frequency monitoring directories |
| `DAILY`   | Every 24 hours   | Standard content directories          |
| `WEEKLY`  | Every 7 days     | Slower-moving curated lists           |
| `MONTHLY` | Every 30 days    | Archival or low-update directories    |

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
- Maximum number of directories with active schedules
- Per-run entitlement check before dispatch

## API Reference

### DirectoryScheduleService

```typescript
// Schedule management
getSchedule(directoryId: string): Promise<ScheduleInfo>

updateSchedule(
    directory: Directory,
    user: User,
    cadence: DirectoryScheduleCadence,
    options?: {
        maxFailureBeforePause?: number;  // 1-10, default: 3
        startAt?: Date;                  // When to begin (default: now + interval)
    }
): Promise<ScheduleInfo>

cancelSchedule(directory: Directory, user: User): Promise<void>
pauseSchedule(directory: Directory, user: User, reason?: string): Promise<void>

// Run lifecycle
markRunDispatched(directoryId: string): Promise<void>
markRunCompleted(directoryId: string): Promise<void>
markRunFailed(directoryId: string, error: string): Promise<void>

// Recovery and validation
recoverStuckSchedules(): Promise<number>  // Returns count of recovered schedules
validateRunEntitlement(directory: Directory, user: User): Promise<{
    allowed: boolean;
    reason?: string;
}>
```

### ScheduleInfo

```typescript
interface ScheduleInfo {
	enabled: boolean;
	cadence: DirectoryScheduleCadence | null;
	status: DirectoryScheduleStatus | null;
	nextRunAt: Date | null;
	lastRunAt?: Date;
	lastError?: string;
	failureCount: number;
	maxFailureBeforePause: number;
}
```

### DirectoryScheduleCadence

```typescript
type DirectoryScheduleCadence = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
```

### DirectoryScheduleStatus

```typescript
type DirectoryScheduleStatus = 'active' | 'paused' | 'dispatched' | 'running' | 'error';
```

## Configuration

### Directory Entity Schedule Fields

The `Directory` entity carries inline schedule fields for quick-access:

```typescript
@Column({ type: 'boolean', default: false })
scheduledUpdatesEnabled: boolean;

@Column({ type: 'varchar', nullable: true })
scheduledCadence?: DirectoryScheduleCadence | null;

@TimestampColumn({ nullable: true })
scheduledNextRunAt?: Date | null;

@Column({ type: 'varchar', nullable: true })
scheduledStatus?: DirectoryScheduleStatus | null;
```

### DirectorySchedule Entity

The `DirectorySchedule` entity (one-to-one with Directory) stores extended scheduling metadata:

- `failureCount` -- current consecutive failure count
- `maxFailureBeforePause` -- threshold for auto-pause
- `lastRunAt` / `lastError` -- most recent run information
- `pausedReason` -- reason for pause (if paused)
- `billingMode` -- `SUBSCRIPTION` or `USAGE`

### Dispatch Integration

Scheduled runs are dispatched through the `DirectoryGenerationDispatcher` interface:

```typescript
interface DirectoryGenerationDispatcher {
	dispatchDirectoryGeneration(payload: DirectoryGenerationPayload): Promise<string | null>;
}

interface DirectoryGenerationPayload {
	directoryId: string;
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
| `@ever-works/agent/database`      | `DirectoryRepository`, `DirectoryScheduleRepository`      |
| `@ever-works/agent/subscriptions` | Plan enforcement and billing mode resolution              |
| `@ever-works/agent/tasks`         | `DIRECTORY_GENERATION_DISPATCHER` for background dispatch |
| `TypeORM`                         | Entity persistence and queries                            |

## Usage Examples

### Enabling a Daily Schedule

```typescript
import { DirectoryScheduleService } from '@ever-works/agent/services';

const schedule = await scheduleService.updateSchedule(directory, user, 'DAILY', { maxFailureBeforePause: 5 });

console.log(`Next run at: ${schedule.nextRunAt}`);
```

### Handling Run Completion

```typescript
// Called by the background worker after successful generation
await scheduleService.markRunCompleted(directoryId);
// Next run time is calculated with drift correction

// On failure
await scheduleService.markRunFailed(directoryId, 'AI provider rate limit exceeded');
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
const { allowed, reason } = await scheduleService.validateRunEntitlement(directory, user);
if (!allowed) {
	console.log(`Schedule blocked: ${reason}`);
	// e.g., "Plan does not allow HOURLY cadence"
}
```
