---
id: schedule-ui
title: Scheduling Interface
sidebar_label: Schedule UI
sidebar_position: 20
---

# Scheduling Interface

The Schedule UI enables users to configure automated, recurring work generation runs. It provides controls for enabling/disabling automation, selecting cadence, managing billing modes, configuring failure thresholds, and triggering immediate runs.

## Component Hierarchy

```
WorkSchedulePage (server component)
  |
  +-- WorkScheduleHeader
  |     +-- Page title
  |     +-- Subtitle with work name
  |
  +-- WorkScheduleCard
        |
        +-- ScheduleEmptyState (if no schedule)
        |     +-- Repeat icon
        |     +-- Empty state title + description
        |     +-- Refresh button
        |
        +-- ScheduleForm (if schedule exists)
              +-- Header (title + subtitle)
              +-- Summary chips (status, next run, last run, failures)
              +-- ActiveProvidersBar (active AI/pipeline providers)
              +-- Form fields (2-column grid):
              |     +-- Automation toggle (Switch)
              |     +-- Billing mode selector (subscription/usage) OR PR toggle
              |     +-- Cadence selector (hourly/daily/weekly/monthly)
              |     +-- Max failures input (1-10)
              |     +-- Pipeline override selector (optional)
              |     +-- Create Pull Request toggle
              +-- Action buttons: Run Now, Save, Cancel
```

## Key Components

### WorkScheduleHeader

**File**: `apps/web/src/components/works/detail/schedule/WorkScheduleHeader.tsx`

A simple header card displaying the page title and a subtitle personalized with the work name.

### WorkScheduleCard

**File**: `apps/web/src/components/works/detail/schedule/WorkScheduleCard.tsx`

The main schedule management component. If no schedule exists, it shows an empty state with a refresh button. Otherwise, it renders the full `ScheduleForm`.

```typescript
type WorkScheduleCardProps = {
	schedule: WorkScheduleDto | null;
	pipelineProviders?: ProviderOption[];
	activeProviders?: ResolvedProvider[];
};
```

### ScheduleForm

The core form component (internal to `WorkScheduleCard`) that manages all schedule configuration.

**Data Model**:

```typescript
interface WorkScheduleDto {
	status: WorkScheduleStatus; // ACTIVE | PAUSED | CANCELLED
	cadence?: WorkScheduleCadence; // HOURLY | DAILY | WEEKLY | MONTHLY
	billingMode?: WorkScheduleBillingMode; // SUBSCRIPTION | USAGE
	nextRunAt?: string; // ISO datetime
	lastRunAt?: string; // ISO datetime
	failureCount: number;
	maxFailureBeforePause: number; // default: 3
	alwaysCreatePullRequest: boolean;
	providerOverrides?: { pipeline?: string };
	allowedCadences?: { cadence: string; allowed: boolean }[];
	subscriptionsEnabled: boolean;
	planCode?: 'free' | 'standard' | 'premium';
}
```

## Form Fields

### Summary Chips

Four read-only summary cards displayed at the top of the form:

| Chip     | Value Source                                     |
| -------- | ------------------------------------------------ |
| Status   | `schedule.status` mapped to localized label      |
| Next Run | `schedule.nextRunAt` rendered via `ShowDateTime` |
| Last Run | `schedule.lastRunAt` rendered via `ShowDateTime` |
| Failures | `failureCount / maxFailureBeforePause` ratio     |

### Automation Toggle

A `Switch` component that enables or disables the schedule. When enabled, the schedule will execute at the configured cadence.

### Cadence Selector

A `Select` dropdown with four options:

| Cadence   | Cron Equivalent | Description    |
| --------- | --------------- | -------------- |
| `HOURLY`  | `0 * * * *`     | Every hour     |
| `DAILY`   | `0 0 * * *`     | Once per day   |
| `WEEKLY`  | `0 0 * * 0`     | Once per week  |
| `MONTHLY` | `0 0 1 * *`     | Once per month |

When subscriptions are enabled, cadence options are restricted by the user's plan. Disallowed cadences are rendered as disabled options. A `HelperPill` displays whether the selected cadence is allowed on the current plan or requires usage-based billing.

### Billing Mode (Subscription-Only)

Visible only when `subscriptionsEnabled` is `true`:

| Mode           | Description                                          |
| -------------- | ---------------------------------------------------- |
| `SUBSCRIPTION` | Runs are included in the subscription plan allowance |
| `USAGE`        | Runs are billed per execution (pay-as-you-go)        |

If the selected cadence is not allowed on the current plan, the billing mode must be set to `USAGE`.

### Max Failures Before Pause

A numeric `Input` field (range: 1-10) controlling how many consecutive failures are tolerated before the schedule is automatically paused. Displays as `{failureCount}/{maxFailureBeforePause}` in the summary.

### Pipeline Override

Visible when multiple pipeline providers are configured. Allows overriding the default pipeline for scheduled runs:

```typescript
interface ProviderOption {
	id: string;
	name: string;
	configured: boolean;
}
```

Unconfigured providers are shown but disabled in the dropdown. The "Inherit" option uses the work's default pipeline.

### Create Pull Request Toggle

A `Switch` controlling whether scheduled generation runs create a git pull request for review rather than committing directly.

## Action Buttons

| Button  | Action                                 | Disabled When                             |
| ------- | -------------------------------------- | ----------------------------------------- |
| Run Now | `runWorkSchedule(workId)`              | Loading, or schedule status is not ACTIVE |
| Save    | `updateWorkSchedule(workId, formData)` | Loading                                   |
| Cancel  | `cancelWorkSchedule(workId)`           | Loading                                   |

Each action uses a separate `useTransition` for independent loading states: `isSaving`, `isRunning`, `isCancelling`.

## State Management

```
WorkScheduleCard
  |
  +-- ScheduleForm
        |-- form.enable: boolean
        |-- form.cadence: WorkScheduleCadence
        |-- form.billingMode: WorkScheduleBillingMode
        |-- form.maxFailureBeforePause: number
        |-- form.alwaysCreatePullRequest: boolean
        |-- form.pipelineOverride: string | undefined
        |-- isSaving: boolean (useTransition)
        |-- isRunning: boolean (useTransition)
        |-- isCancelling: boolean (useTransition)
```

The form state is initialized from the `schedule` prop via `deriveFormState()` and re-derived whenever the schedule prop changes (via `useEffect`).

## Background Task Integration

The schedule dispatcher runs as a Trigger.dev cron task defined in `packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts`:

```typescript
export const workScheduleDispatcherTask = schedules.task({
	id: 'work-schedule-dispatcher',
	cron: `*/${interval} * * * *`, // configurable interval
	run: async () => {
		const dispatcher = appContext.get(WorkScheduleDispatcherService);
		const dispatched = await dispatcher.dispatchDue();
		return { dispatched, intervalMinutes: interval };
	}
});
```

This cron task checks for due schedules and dispatches generation tasks at the configured interval.

## Related API Endpoints

| Action          | Server Action Function                 | HTTP Method |
| --------------- | -------------------------------------- | ----------- |
| Update schedule | `updateWorkSchedule(workId, formData)` | PATCH       |
| Run immediately | `runWorkSchedule(workId)`              | POST        |
| Cancel schedule | `cancelWorkSchedule(workId)`           | POST        |

## Internationalization

All strings use `next-intl` under these namespaces:

- `dashboard.workDetail.schedule.page` -- page header title and subtitle
- `dashboard.workDetail.schedule.card` -- form labels, summaries, actions, cadence labels, billing labels, error messages, success messages
- `dashboard.workDetail.schedule.card.cadence.*` -- cadence option labels (hourly/daily/weekly/monthly)
- `dashboard.workDetail.schedule.card.plans.*` -- plan names (free/standard/premium/unmetered)

## Cross-References

- [Generation History](./history-ui.md) -- scheduled runs appear in history with status tracking
- [Logging & Aggregation](../devops/logging-aggregation.md) -- TriggerLogger captures dispatcher logs
- [Performance Monitoring](../devops/performance-monitoring.md) -- schedule dispatch metrics
- [Items Management UI](./items-ui.md) -- generation creates/updates items
- [Deployment UI](./deployment-ui.md) -- deploy after automated generation
