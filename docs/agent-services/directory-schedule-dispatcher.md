---
id: directory-schedule-dispatcher
title: "DirectoryScheduleDispatcherService Deep Dive"
sidebar_label: "Schedule Dispatcher"
sidebar_position: 15
---

# DirectoryScheduleDispatcherService Deep Dive

## Overview

The `DirectoryScheduleDispatcherService` is the cron-triggered entry point that finds due directory schedules and dispatches their scheduled updates. It handles zombie schedule recovery, atomic reservation of schedules to prevent duplicate processing, and delegates the actual generation work to `DirectoryGenerationService`.

## Architecture

This service runs at the outermost layer of the scheduling system, typically invoked by a cron job or background task runner. It coordinates between the schedule repository (to find due schedules), the schedule service (for state management), and the generation service (for executing updates).

```
Cron Job / Trigger.dev Task
        |
        v
DirectoryScheduleDispatcherService.dispatchDue(limit?)
        |
        +-- Step 0: recoverStuckSchedules()           <-- cleanup zombies
        |
        +-- Step 1: scheduleRepository.findDue(limit)  <-- find ready schedules
        |
        +-- Step 2: For each schedule:
        |       |
        |       +-- markRunDispatched(schedule.id)     <-- atomic reservation
        |       |
        |       +-- directoryGenerationService.runScheduledUpdate(schedule)
        |       |
        |       +-- On error: markRunFailed(schedule.id, errorMessage)
        |
        v
Returns: number of dispatched schedules
```

## API Reference

### Methods

#### `dispatchDue(limit?)`

Finds and dispatches all due scheduled directory updates.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | `number` | `config.subscriptions.getMaxBatch()` | Maximum number of schedules to process in this batch |

**Returns:** `Promise<number>` -- the count of successfully dispatched schedules.

## Implementation Details

### Feature Gate

The method first checks `config.subscriptions.scheduledUpdatesEnabled()`. If scheduled updates are disabled globally, it logs a warning and returns `0` immediately. This allows operators to pause all scheduled processing without code changes.

### Zombie Recovery

Before finding due schedules, the service calls `recoverStuckSchedules()` on the `DirectoryScheduleService`. This handles schedules that were marked as "dispatched" but never completed (e.g., due to a worker crash), resetting them to a retriable state.

### Atomic Reservation

The `markRunDispatched()` call acts as a pessimistic lock. If another dispatcher instance already reserved the schedule (race condition in a multi-instance deployment), the method returns `null` and the schedule is skipped with a warning log. This prevents duplicate generation runs.

### Sequential Processing

Schedules are processed sequentially in a `for` loop rather than in parallel. This is intentional to:

1. Prevent resource exhaustion from concurrent generation jobs
2. Allow the configurable `limit` to act as a true batch ceiling
3. Ensure individual failures do not cascade to other schedules

### Error Isolation

Each schedule is processed inside its own try-catch block. A failure in one schedule's generation does not prevent subsequent schedules from being dispatched. Failed schedules are marked via `markRunFailed()` with the error message.

## Database Interactions

| Repository / Service | Method | Purpose |
|---------------------|--------|---------|
| `DirectoryScheduleRepository` | `findDue(limit)` | Query for schedules whose next run time has passed |
| `DirectoryScheduleService` | `recoverStuckSchedules()` | Reset zombie schedules |
| `DirectoryScheduleService` | `markRunDispatched(id)` | Atomically reserve a schedule for processing |
| `DirectoryScheduleService` | `markRunFailed(id, message)` | Record schedule failure |
| `DirectoryGenerationService` | `runScheduledUpdate(schedule)` | Execute the actual directory generation |

## Event System

This service does not emit events directly. Events are emitted by the downstream `DirectoryGenerationService` upon completion.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Scheduled updates disabled | Returns `0`, logs warning |
| Schedule already reserved | Logs warning, skips to next |
| Generation failure | Calls `markRunFailed()`, continues to next schedule |
| Repository query failure | Propagates the exception (no schedules processed) |

## Usage Examples

```typescript
// Typically called from a cron task
const dispatched = await schedulerDispatcher.dispatchDue();
console.log(`Dispatched ${dispatched} scheduled updates`);

// With a custom batch limit
const dispatched = await schedulerDispatcher.dispatchDue(5);
```

## Configuration

| Setting | Source | Description |
|---------|--------|-------------|
| `scheduledUpdatesEnabled` | `config.subscriptions` | Global feature flag for scheduled updates |
| `getMaxBatch` | `config.subscriptions` | Default maximum batch size per dispatch cycle |

## Related Services

- [Directory Scheduling](/agent-services/directory-scheduling) -- manages schedule CRUD and state transitions
- [Directory Generation](/agent-services/directory-generation) -- executes the actual generation work
- [Directory Import Service](/agent-services/directory-import-service) -- creates sync schedules for imported directories
