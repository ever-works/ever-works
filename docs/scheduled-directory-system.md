# Scheduled Directory System – End-to-End Guide

This document explains how our automated directory refresh feature works. It covers backend architecture, batch dispatching, Trigger.dev integration, subscription toggles, environment variables, and the frontend experience. Treat it as the single source of truth for anyone touching scheduled updates.

---

## 1. High-Level Overview

1. A user manually generates a directory and saves a prompt/config (`config.metadata.initial_prompt` and `config.metadata.last_request_data`).
2. Once that metadata exists, the schedule UI becomes available and the backend accepts schedule API calls.
3. The user chooses cadence, billing mode, and safeguards. The backend validates those choices against plan limits or pay-per-use rules.
4. `DirectoryScheduleService` persists schedule information and mirrors denormalized data onto the `Directory` entity (so dashboards can render state quickly).
5. `DirectoryScheduleDispatcherService` runs on a cron-like cadence (Trigger.dev task or Nest fallback). Each run fetches due schedules in batches and enqueues generation runs.
6. `DirectoryGenerationService.runScheduledUpdate()` reuses the same pipeline as manual runs, pulling `last_request_data` and invoking Trigger.dev or in-process fallbacks.
7. After each run finishes, the schedule record is updated with the latest status, timestamps, and failure counts. Usage ledger entries are written if pay-per-use billing was requested.

---

## 2. Backend Architecture

### Core Entities

- **DirectorySchedule** – stores cadence, status, billing mode, next/last run timestamps, failure counters, etc.
- **Directory** (denormalized fields) – `scheduledUpdatesEnabled`, `scheduledCadence`, `scheduledNextRunAt`, `scheduledStatus` keep the dashboard fast.
- **SubscriptionPlan** / **UserSubscription** – define cadence allowances and plan metadata when subscriptions are turned on.
- **UsageLedgerEntry** – optional row per pay-per-use run when subscriptions enforce cadence limits.

### Key Services

- `DirectoryScheduleService`
    - Ensures the caller owns the directory.
    - Calls `DataGeneratorService.config()` to guarantee `metadata.initial_prompt` exists.
    - Validates cadences and billing modes against plan limits (or forces usage billing).
    - Caps failure thresholds.
    - Mirrors schedule state back to the `Directory` table.
    - Exports DTOs for API/UI consumption (includes `subscriptionsEnabled`).
    - **Validates run entitlement at runtime** (pauses schedules if plan limits are exceeded).
    - **Recovers stuck schedules** (marks "zombies" as failed if stuck in `GENERATING` > 1 hour).

- `DirectoryScheduleDispatcherService`
    - Runs cleanup for stuck schedules (`recoverStuckSchedules`) before dispatching.
    - Reads `findDue(limit)` from the repository, where `limit = SCHEDULED_UPDATES_MAX_BATCH`.
    - For each result, calls `markRunDispatched()` (atomic update that clears `nextRunAt` and sets status to "generating" to prevent duplicate dispatch).
    - Invokes `DirectoryGenerationService.runScheduledUpdate()` for each reserved schedule.

- `DirectoryGenerationService`
    - Reuses last request data from the directory config (handles stale config gracefully by pausing schedule).
    - Creates a new history entry with `triggeredBy='schedule'`.
    - Dispatches the Trigger.dev task or performs in-process generation if Trigger.dev is disabled/unavailable.
    - **Sequential Fallback**: When Trigger.dev is unavailable, scheduled runs execute sequentially in-process to prevent resource exhaustion.
    - Calls back into `DirectoryScheduleService.markRunCompleted()` or `.markRunFailed()` when the run finishes.
    - **Drift Prevention**: Calculates next run time based on the *scheduled* time, not completion time.

### Trigger.dev + Fallback Cron

- Primary mode: `packages/tasks/src/tasks/trigger/directory-schedule-dispatcher.task.ts` registers a Trigger.dev cron task (default every 5 minutes). The task boots a Nest context, resolves `DirectoryScheduleDispatcherService`, and processes the batch.
- Fallback mode (when `TRIGGER_ENABLED=false`): Nest's cron scheduler calls the same dispatcher service. Config is identical; only the triggering mechanism changes.

---

## 3. Batch Dispatch Flow

```mermaid
flowchart TD
    A[Dispatcher cron tick] --> Z[Recover Stuck Schedules]
    Z --> B[findDue(MAX_BATCH)]
    B -->|<= N rows| C{markRunDispatched}
    C -->|success| D[runScheduledUpdate(schedule)]
    D --> E[Trigger.dev task or in-process run]
    E --> F{Run result}
    F -->|success| G[markRunCompleted (Next run based on schedule anchor)]
    F -->|failure| H[markRunFailed / pause when threshold hit]
```

- `recoverStuckSchedules()` identifies rows stuck in `GENERATING` for > 1 hour and marks them failed to prevent "zombies".
- `findDue(limit)` retrieves active schedules with `nextRunAt <= now()`.
- If there are more due rows than the batch size, the dispatcher simply processes `limit` items this tick. The remaining rows are picked up on the next cron run—this prevents sending 1,000 runs at once.
- `markRunDispatched(scheduleId)` uses a `WHERE status=ACTIVE AND nextRunAt IS NOT NULL` clause to atomically reserve a row. If two dispatchers race, only one succeeds and the other drops the row from this cycle.
- `runScheduledUpdate()` loads the full `Directory` and `User`, validates subscription limits (pausing if exceeded), fetches `last_request_data`, and calls `updateItemsGenerator()`.
- Completion/failure paths set `nextRunAt` (using the original scheduled time as an anchor to prevent drift), `lastRunAt`, `lastRunStatus`, reset/increment failure counters, and optionally pause the schedule when `failureCount >= maxFailureBeforePause`.

---

## 4. Subscription On/Off Behavior

### Flag: `SUBSCRIPTIONS_ENABLED`

- Located in `apps/api/.env.example` and `packages/agent/src/config/index.ts`.
- When **true**:
    - `SubscriptionService` resolves the user plan (default from `SUBSCRIPTIONS_DEFAULT_PLAN` if none stored).
    - `DirectoryScheduleService` enforces `plan.maxDirectories`.
    - Cadences outside the allowed list require `billingMode='usage'`, otherwise the API returns a 400 with an upgrade hint.
    - `UsageLedgerService.recordUsage()` writes ledger entries and notifies the billing provider when scheduled runs use pay-per-use.
    - The web UI displays plan names, billing selectors, pay-per-use toggles, and upgrade hints.

- When **false**:
    - `SubscriptionService` short-circuits and returns a synthetic "free/unmetered" plan where every cadence is allowed.
    - `DirectoryScheduleService` skips directory-count limits and never forces pay-per-use.
    - `UsageLedgerService` becomes a no-op.
    - `DirectoryScheduleDto.planCode` is omitted, and the UI hides billing controls.
    - API endpoints that change plans (`/api/subscriptions/plan`) throw `Subscriptions are disabled`.

### Additional Subscription-Related Env Vars (`apps/api/.env.example`):

| Variable                                     | Purpose                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `SUBSCRIPTIONS_ENABLED`                      | Master flag for enabling billing/subscription enforcement.       |
| `SUBSCRIPTIONS_DEFAULT_PLAN`                 | Plan code used when the user has no explicit subscription.       |
| `BILLING_DEFAULT_CURRENCY`                   | Currency stored on plan/ledger rows (default `usd`).             |
| `PAY_PER_USE_PRICE_USD`                      | Price used when billing per run. Converted to cents in config.   |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Reserved for future Stripe integration (currently unused stubs). |

---

## 5. Scheduled Updates Env Vars

Located in `apps/api/.env.example` and consumed by `packages/agent/src/config/index.ts`:

| Variable                                      | Effect                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `SCHEDULED_UPDATES_ENABLED`                   | Global kill switch to disable the entire scheduling feature (UI + backend). |
| `SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES` | Cron interval for dispatcher when Trigger.dev is enabled (default 5).       |
| `SCHEDULED_UPDATES_MAX_BATCH`                 | Number of schedules processed per dispatcher run (default 25).              |
| `SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE`  | Default failure threshold before auto-pausing (user can override 1–10).     |

---

## 6. Frontend Flow (apps/web)

1. `DirectoryLayout` fetches `/directories/:id` + `/directories/:id/config`. If `config.metadata.initial_prompt` is missing, the schedule tab is hidden and `/schedule` routes return 404.
2. `DirectorySchedulePage` fetches `/directories/:id/schedule`. If the API fails (no schedule yet), the card renders an empty state prompting a manual refresh.
3. `DirectoryScheduleCard` displays:
    - Summary chips (status, next run, last run, failures).
    - Automations toggle.
    - Billing selector (only if subscriptions enabled).
    - Cadence dropdown + pay-per-use helper pill.
    - Failure threshold input.
    - `Run now`, `Save`, `Cancel` buttons with server actions.
4. Client actions (`updateDirectorySchedule`, `runDirectorySchedule`, `cancelDirectorySchedule`) call server routes which wrap the API. Success/failure toasts come from `sonner`.

---

## 7. Trigger.dev Task Summary

- **File**: `packages/tasks/src/tasks/trigger/directory-schedule-dispatcher.task.ts`
- **Trigger**: `onSchedule({ cron: '*/5 * * * *' })` (configurable via env).
- **Workflow**:
    1. Boot Nest application context.
    2. Resolve `DirectoryScheduleDispatcherService`.
    3. Execute `dispatchDue()` with `MAX_BATCH`.
    4. Report metrics/logging for monitoring.
- **Fallback**: When Trigger.dev is unavailable, Nest's own scheduler (enabled via a configuration flag) calls the same service to preserve behavior.

---

## 8. Failure Handling and Auto-Pause

- Every run increments `failureCount` when it ends with `GenerateStatusType.ERROR`.
- `maxFailureBeforePause` defaults to `SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE` but can be set per directory (bounded 1–10).
- When the limit is reached:
    - The schedule is automatically paused (`status=PAUSED`).
    - `nextRunAt` is cleared.
    - The UI shows the paused state and instructs the user to investigate errors.
    - If the user re-enables later, failure count resets.
- If a failure happens but the limit isn’t reached, `nextRunAt` is bumped forward (default 15-minute delay before the next attempt).

---

## 9. Usage Ledger Rules

- Only active when subscriptions are enabled **and** the schedule’s `billingMode === 'usage'`.
- Each run records:
    - `userId`, `directoryId`, `scheduleId`
    - `triggerType='scheduled'`
    - `units=1`
    - `amountCents = PAY_PER_USE_PRICE_USD * 100`
    - `metadata.cadence`
- Ledger entries are sent to `BillingProvider` (currently a manual stub). Future Stripe integration will listen for these entries to create invoices.

---

## 10. Initial Prompt Requirement

The entire system depends on `config.metadata.initial_prompt` and `config.metadata.last_request_data`. We enforce this in two places:

1. **UI**: `DirectoryLayout` only enables the schedule tab when the config contains an initial prompt. Otherwise, `/schedule` routes return 404.
2. **Backend**: `DirectoryScheduleService.ensureDirectoryConfigReady()` loads the config using `DataGeneratorService.config()` for every `getSchedule` and `updateSchedule` call. If the prompt is missing, it throws a `400` (“Complete an initial directory setup before enabling scheduled updates.”).

This guard ensures scheduled runs always have the context needed to regenerate content.

---

## 11. Quick Reference

| Component        | File/Location                                                             | Notes                                                                 |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| API endpoints    | `apps/api/src/directories/directories.controller.ts` (`/schedule` routes) | All authenticated via JWT guard.                                      |
| Schedule service | `packages/agent/src/services/directory-schedule.service.ts`               | Contains validation, DTO mapping, and directory syncing.              |
| Dispatcher       | `packages/agent/src/services/directory-schedule-dispatcher.service.ts`    | Handles batching and locking.                                         |
| Trigger task     | `packages/tasks/src/tasks/trigger/directory-schedule-dispatcher.task.ts`  | Cron-based dispatcher runner.                                         |
| Config           | `packages/agent/src/config/index.ts`                                      | Exposes typed accessors for env vars, including subscription toggles. |
| Frontend card    | `apps/web/src/components/directories/detail/DirectoryScheduleCard.tsx`    | Client-side UI and server actions.                                    |
| Env reference    | `apps/api/.env.example`                                                   | Contains every variable described above.                              |

---

## 12. Frequently Asked Questions

**Q: What happens when many schedules are due but `SCHEDULED_UPDATES_MAX_BATCH` is small?**  
A: Each dispatcher run processes only `MAX_BATCH` rows. Remaining rows stay due and will be picked up on the next tick (default every 5 minutes). Adjust batch size or interval if you need faster throughput.

**Q: Can scheduling run without Trigger.dev?**  
A: Yes. If `TRIGGER_ENABLED=false`, our Nest cron fallback kicks in, using the same dispatcher service. Manual runs also work because `DirectoryGenerationService` falls back to in-process execution when Trigger.dev dispatch fails.

**Q: How do we re-enable subscriptions later?**  
A: Flip `SUBSCRIPTIONS_ENABLED=true`. The backend instantly enforces plan limits; the UI automatically re-renders billing controls because the DTO includes `subscriptionsEnabled=true`. Existing schedules keep their cadence, but users will see pay-per-use messaging if they exceed plan allowances.

**Q: Why do I sometimes see “Complete an initial directory setup before enabling scheduled updates”?**  
A: The directory’s config repository doesn’t contain `metadata.initial_prompt` yet. Run a manual generation (or supply the prompt), then refresh the schedule page.

---

This guide should eliminate guesswork while maintaining the flexibility to evolve the system. If you extend scheduling or billing behavior, update this document so future collaborators stay aligned.\*\*\*
