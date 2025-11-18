# Scheduled Directory Updates & Subscription System

## Background

- `apps/web/src/app/[locale]/(dashboard)/directories/[id]/page.tsx` renders the directory overview but does not expose any controls beyond read-only stats.
- `apps/api/src/directories/directories.controller.ts` and the services in `packages/agent/src/services` only expose immediate, user-triggered generation (`generateItems`, `updateItemsGenerator`, manual item submissions, etc.).
- `packages/agent/src/tasks/trigger/directory-generation.task.ts` defines a single Trigger.dev task that handles both create and update flows, but there is no scheduler that queues automated updates or differentiates user-initiated runs.
- No subscription/billing primitives exist on `User` or `Directory` entities; `.env.example` does not expose any billing or scheduling toggles.

We need an end-to-end subscription-aware scheduling system that lets users configure automatic directory refreshes according to tier and optionally pay per use.

## Goals

1. Allow a user to enable "Scheduled Updates" on a directory from the dashboard, selecting from tier-based cadences (1h premium, 24h standard, 168h standard weekly, 720h free monthly).
2. Encode a subscription system with three tiers (`free`, `standard`, `premium`) that governs which cadences can be selected, supports cancellation/pause, and meters per-run usage for pay-per-use billing.
3. Persist scheduling metadata (status, cadence, next execution, last execution result, billing mode).
4. Run scheduled updates automatically by reusing the existing generation pipeline (Trigger.dev task + `DirectoryGenerationService`).
5. Add documentation for the new system in `docs/`.

Out of scope (future refactors):

- Real payment processor integration (Stripe/Upstash/other) beyond defining hooks and environment configuration points.
- UI for upgrading payment method or invoices (only gating scheduled actions and exposing upgrade CTA now).

## Requirements

### Functional

- Toggle scheduled updates per directory with ability to pause/cancel at any time.
- Ensure a directory cannot set a cadence higher than its owner's active plan allows.
- Support "pay per use" where a run outside the plan (e.g., a free user wanting weekly+daily override) consumes usage credits and is recorded in a ledger.
- Provide backend APIs to fetch schedule/subscription state, update it, and surface in the UI.
- Scheduler must be idempotent and resilient (no double-dispatch, record retries, auto-pause after repeated failures).
- Event history should mark whether a run was user, schedule, or pay-per-use triggered.

### Non-Functional

- Configurable globally (enable/disable scheduling, default plan) through environment variables.
- Extendable for future billing providers and more tiers without large migrations.
- All new DB interactions must use TypeORM repositories defined under `packages/agent/src/database`.

## Proposed Architecture

### Data Model (TypeORM entities under `packages/agent/src/entities`)

| Entity                      | Purpose                                    | Key Fields                                                                                                                                      |
| --------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `SubscriptionPlan` (seeded) | Defines tiers and allowed cadences         | `code (free/standard/premium)`, `displayName`, `maxDirectories`, `allowedCadences (jsonb)`, `monthlyPrice`, `overagePricePerRun`                |
| `UserSubscription`          | Tracks the plan a user is on               | `userId`, `planCode`, `status (active/canceled/past_due)`, `billingProvider`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `paymentMethodMeta`      |
| `DirectorySchedule`         | Stores directory-specific scheduling state | `directoryId (unique)`, `userId`, `cadence (enum hour/day/week/month)`, `billingMode (subscription                                              | usage)`, `status (active | paused | canceled)`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `failureCount`, `maxFailureBeforePause`, `initiatedBySubscriptionId` |
| `UsageLedgerEntry`          | Pay-per-use ledger                         | `id`, `userId`, `directoryId`, `triggerType (manual/scheduled)`, `billingMode`, `units (int)`, `amount`, `status (pending/paid)`, `meta (json)` |

Additional adjustments:

- `DirectoryGenerationHistory` gets an extra column `triggeredBy` (`user`, `schedule`, `api`) plus `scheduleId` foreign key to link to runs triggered by the scheduler.
- `Directory` entity holds denormalized info for faster lookups: `scheduledUpdatesEnabled`, `scheduledCadence`, `scheduledNextRunAt`, `scheduledStatus` (sync with `DirectorySchedule`).
- `User` entity gets optional `defaultPlan` relation pointer.

### Scheduling Flow

1. User enables scheduled updates → API creates/updates `DirectorySchedule`.
2. A new service `DirectoryScheduleService` (packages/agent) calculates `nextRunAt` respecting plan allowances and writes to repository.
3. Background worker polls `DirectorySchedule` table (status active, `nextRunAt <= now`, `failureCount < max`) and dispatches `directoryGenerationTask` with a new `mode: 'scheduled_update'`.
4. `directory-generation.task.ts` forwards to `TriggerGenerationOrchestrator` unchanged, but payload includes `scheduleId` and `triggeredBy`.
5. `DirectoryGenerationService` updates `DirectorySchedule` and the ledger after the run, resetting `failureCount` or incrementing/pausing on errors.

### Scheduler Implementation Options

- **Primary**: New Trigger.dev task `directory-schedule-dispatcher` with `onSchedule` (every 5 minutes) that bootstraps Nest context, queries due schedules, and enqueues generation tasks.
- **Fallback (if Trigger disabled)**: NestJS Cron (`@nestjs/schedule`) running inside API to perform the same query/dispatch (guarded by `SCHEDULED_UPDATES_USE_CRON=true`).

### Subscription Enforcement

- `DirectoryScheduleService` checks the owner’s `UserSubscription`. If plan is `free`, only allow the monthly cadence; `standard` may allow weekly or daily (per product definition), `premium` allows hourly + all lower tiers.
- Attempting to set a faster cadence than allowed either (a) returns a `402 Upgrade Required` style error, or (b) automatically sets `billingMode='usage'` and logs a ledger entry to charge per run (configurable).
- Provide API surfaces both the allowed cadences and the ones currently active so the UI can render upgrade CTAs.

### Pay-per-Use

- UI lets user select "Run daily even if I'm on the free plan" by ticking "bill per run" (if plan insufficient).
- When a scheduled run executes with `billingMode='usage'`, write `UsageLedgerEntry` with `status='pending'`. Billing integration (Stripe) will read ledger later; for now, expose stub service that simply records entries.
- Provide endpoint to list outstanding usage entries for transparency.

## Backend Implementation Plan

### packages/agent

1. **Entities/Repositories**
    - Add TypeORM entities mentioned above + migrations (SQLite/other). Extend `packages/agent/src/database` to register repositories (e.g., `DirectoryScheduleRepository`, `SubscriptionPlanRepository`, `UserSubscriptionRepository`, `UsageLedgerRepository`).
    - Update `DirectoryRepository` to expose `findWithScheduleById` helper returning joined schedule info to reduce queries for directory detail API.
2. **Services**
    - `DirectoryScheduleService`: CRUD operations, plan enforcement, `calculateNextRun` helper, `markRunStarted/Finished`, failure auto-pause.
    - `SubscriptionService`: resolves user plan (default `free` if no record), handles plan upgrades/cancel (status transitions + event hooks). Provide method `getAllowedCadences(userId)` to reuse across API.
    - Update `DirectoryGenerationService` to accept a `triggerSource` param so scheduled runs can skip manual validations but still use `updateItemsGenerator`. The service should accept the `scheduleId` to (a) lock schedule before run, (b) call `DirectoryScheduleService.completeRun`.
3. **Tasks**
    - Introduce `packages/agent/src/tasks/trigger/directory-schedule-dispatcher.task.ts` using Trigger.dev `task` with `trigger: cron`. This task loads `DirectoryScheduleDispatcher` service to dispatch due runs in batches (respecting concurrency). Provide fallback Cron runner when Trigger is disabled.
4. **Events**
    - Emit new `DirectoryScheduleUpdatedEvent` + `DirectoryScheduleRunFailedEvent` for observability (tying into `EventEmitter2` used elsewhere).

### apps/api

1. **Modules**
    - Extend `DirectoriesModule` to import a new `SubscriptionsModule` (under `apps/api/src/subscriptions`). This module wraps the new services from `packages/agent` and exposes REST endpoints.
2. **Controllers**
    - Add endpoints under `/api/directories/:id/schedule` for GET/PUT/DELETE (pause/cancel) and `/api/directories/:id/schedule/run-now` to trigger pay-per-use runs.
    - Add `/api/subscriptions/plan` GET/PUT endpoints for the user to view/change their subscription tier (even if actual billing is manual now, keep API symmetrical).
3. **DTOs & Validation**
    - Create DTOs for schedule updates (`cadence`, `billingMode`, `autoPauseAfterFailures`). Validate cadence with class-validator and cross-check allowed values from `SubscriptionService`.
4. **Responses**
    - Extend directory detail response to embed `schedule` object (`{active, cadence, nextRunAt, status, billingMode, lastRunAt, lastRunStatus}`) so the UI can render everything with a single fetch.
5. **Auth Guarding**
    - All new endpoints use `JwtAuthGuard` and rely on `DirectoryOwnershipService` to ensure user access.

### apps/web

1. **Directory Overview Page**
    - Update server component to fetch `schedule` and `subscription` metadata via new API endpoints before rendering.
    - Introduce a new client component `DirectoryScheduleCard` under `apps/web/src/components/directories/detail` that shows:
        - Current plan & cadence
        - Next/last run timestamps + status.
        - Toggle to pause/resume.
        - Dropdown for cadence selection (disabled options show lock icon + upgrade CTA).
        - "Run now (pay per use)" button when plan inadequate (calls new mutation).
2. **API Layer**
    - Extend `apps/web/src/lib/api/directory.ts` with `getSchedule`, `updateSchedule`, `cancelSchedule`, `runSchedule` methods, and update the TypeScript interfaces.
    - Add `SubscriptionAPI` helper exposing `/api/subscriptions` endpoints for plan management so the UI can gate features and render plan badges.
3. **State Management**
    - Use `useOptimistic` or toast notifications for schedule updates while waiting for server response; show errors returned from API.
4. **Internationalization**
    - Add new translation strings (English) under `apps/web/src/messages/...` for schedule UI text.

## API Contract Draft

| Method   | Endpoint                            | Description                                                               |
| -------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `GET`    | `/api/directories/:id/schedule`     | Returns `DirectoryScheduleDto` & allowed cadences                         |
| `PUT`    | `/api/directories/:id/schedule`     | Creates/updates cadence, billing mode, autopause config                   |
| `POST`   | `/api/directories/:id/schedule/run` | Immediately dispatches a run (counts toward usage ledger if outside plan) |
| `DELETE` | `/api/directories/:id/schedule`     | Cancels schedule + optionally removes ledger entries                      |
| `POST`   | `/api/subscriptions/plan`           | Change plan (records pending upgrade + attaches billing provider intent)  |
| `GET`    | `/api/subscriptions/plan`           | Returns plan, renewal date, allowed cadences/limits                       |

`DirectoryScheduleDto` shape:

```ts
type DirectoryScheduleDto = {
	status: 'disabled' | 'active' | 'paused' | 'canceled';
	cadence: 'hourly' | 'daily' | 'weekly' | 'monthly' | null;
	billingMode: 'subscription' | 'usage';
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastRunStatus: GenerateStatusType | null;
	failureCount: number;
	maxFailureBeforePause: number;
	allowedCadences: Array<{ cadence: string; reason?: string; payPerUse?: boolean }>;
};
```

## Environment & Configuration

Add to `apps/api/.env.example`:

```
# Scheduled Updates / Billing
SCHEDULED_UPDATES_ENABLED=true
SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES=5
SCHEDULED_UPDATES_MAX_BATCH=25
SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE=3
SUBSCRIPTIONS_DEFAULT_PLAN=free
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PAY_PER_USE_PRICE_USD=5
```

Update `packages/agent/src/config` to read these values and expose a strongly typed config service consumed by scheduler + services.

## Example Scenario

1. **Free plan monthly update**
    - User (plan `free`) opens directory detail, toggles scheduled updates.
    - API validates allowed cadence → only monthly available → sets `DirectorySchedule` with `cadence='monthly'`, `status='active'`, calculates `nextRunAt` = now + 30 days.
    - Scheduler triggers after 30 days, run completes, history entry flagged as `triggeredBy='schedule'`.
2. **Standard plan daily + pay-per-use hourly burst**
    - User on `standard` selects daily schedule (allowed). Later opts into `Run hourly for next 24h (pay per use)` which sets `billingMode='usage'` for that cadence and writes ledger entries every run.
3. **Premium cancellation**
    - Premium user cancels plan. `UserSubscription` status becomes `canceled` but schedule stays active until `currentPeriodEnd`; backend automatically downgrades cadence to next allowed value (weekly) afterwards and notifies UI.

## Task Checklist

### Data & Config

- [ ] Create new entities (`SubscriptionPlan`, `UserSubscription`, `DirectorySchedule`, `UsageLedgerEntry`) with migrations for sqlite/postgres/mysql targets.
- [ ] Seed default plans (free/standard/premium) during bootstrap or via migration script.
- [ ] Update `Directory` & `DirectoryGenerationHistory` entities with new fields.

### Agent Services & Tasks

- [ ] Implement repositories + services for subscriptions, schedules, usage ledger.
- [ ] Extend `DirectoryGenerationService` to accept schedule context + trigger type.
- [ ] Create scheduler dispatcher task (Trigger.dev cron + Nest fallback).
- [ ] Wire new services into existing modules (e.g., `DirectoryOperationsModule` or new `SchedulingModule`).

### API Layer (`apps/api`)

- [ ] Add `SubscriptionsModule` + controllers/routes for plan and schedule management.
- [ ] Extend `DirectoriesController` responses to include schedule data.
- [ ] Add validations + guards ensuring cadence matches plan or is billed per use.
- [ ] Update `.env.example` & config services for new variables.

### Web App (`apps/web`)

- [ ] Add API helpers for schedule + subscription endpoints.
- [ ] Update directory overview page to fetch new data and render `DirectoryScheduleCard`.
- [ ] Implement client component for editing cadence, pausing, and running now with proper UX + translations.

### Docs & QA

- [x] Author this specification in `docs/scheduled-directory-updates.md`.
- [ ] Expand user-facing docs (later) once feature ships.
- [ ] Define test plan (unit tests for services, e2e for scheduler) and add to CI.

## Open Questions / Follow-ups

All outstanding questions are now resolved so the implementation can proceed without ambiguity:

1. **Billing provider** → Stripe is the canonical billing provider. `billingProvider` enums should default to `'stripe'`, but we keep the column nullable to allow future providers. All plan/usage events will emit Stripe-friendly payloads so a future webhook listener can invoice customers.
2. **Usage ledger settlement** → We aggregate ledger entries once per UTC day. A new (future) billing-worker job will pull all `UsageLedgerEntry` rows with `status='pending'` grouped by user, create a single Stripe invoice item, and then set them to `status='queued_for_settlement'`. Until that worker exists, the API simply records entries and exposes them for manual review.
3. **Generation behavior** → Scheduled runs continue to use the existing sequential pipeline in `DirectoryGenerationService` (data → markdown → website). No early repository count updates occur; stats update only after the orchestrator completes, matching manual runs.
4. **Failure auto-pause** → Each schedule stores `maxFailureBeforePause`, defaulting to `SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE` (currently 3). Users can override this per-directory (bounded 1-10) through the schedule API, enabling multitenant flexibility without extra configuration knobs elsewhere.

Implementation should follow the resolved decisions above.
