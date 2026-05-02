# Architecture: Trigger.dev Worker

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers writing Trigger.dev tasks,
debugging worker bootstraps, or wiring new background jobs.

---

## 1. Purpose

Every long-running platform operation — directory generation, Awesome
README import, scheduled dispatch, source-validation cadence,
notification cleanup, cache sweep — runs as a **Trigger.dev task**.
This spec covers the **task package layout**, the **per-task NestJS
bootstrap pattern**, the **cron task wiring**, the **error → activity
log mapping**, and the **run-output schema** every task returns.

The companion document
[`trigger-integration`](./trigger-integration.md) is a higher-level
overview of _why_ Trigger.dev is part of the architecture; this spec
covers _how_ the integration is wired in code.

## 2. Package Layout

```
packages/tasks/
├── package.json                           # @ever-works/trigger-tasks
├── trigger.config.ts                      # Trigger.dev project config
├── build/                                  # Build helpers
└── src/
    ├── index.ts
    ├── tasks/
    │   └── trigger/
    │       ├── directory-generation.task.ts          # Long generation runs
    │       ├── directory-import.task.ts              # Awesome README import
    │       ├── directory-schedule-dispatcher.task.ts # Cron entry point
    │       └── index.ts
    └── trigger/
        └── worker/
            ├── modules/                              # Bootstrap-only modules
            │   └── trigger-internal.module.ts
            ├── trigger-logger.ts                     # Logger-bridge factory
            └── ...
```

The package is **separate from `apps/api`** because the Trigger.dev
worker runs in its own process pool — it doesn't share the API's
HTTP server, port, or lifecycle. Both processes bootstrap the same
`@ever-works/agent` services through DI but in independent
application contexts.

## 3. Per-Task Bootstrap Pattern

Every task follows the same skeleton:

```ts
// packages/tasks/src/tasks/trigger/<my>.task.ts
import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { MyService } from '@ever-works/agent/<sub-export>';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

export const myTask = task({
	id: 'my-task',
	run: async (payload: MyPayload, { ctx }) => {
		const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
		appContext.useLogger(createTriggerLogger('MyTask'));

		try {
			const service = appContext.get(MyService);
			return await service.doTheWork(payload);
		} finally {
			await appContext.close();
		}
	}
});
```

Key invariants:

1. **Fresh app context per run** — each task creates and closes its
   own `INestApplicationContext`. No shared state across runs.
2. **Logger bridge** — `createTriggerLogger(prefix)` adapts the
   NestJS `Logger` interface to Trigger.dev's run logger so log
   lines surface in the Trigger.dev dashboard with task context.
3. **Always close in `finally`** — failure to close leaks the DB
   connection pool, the cache adapter, and timers. Every task does
   this explicitly.
4. **Return value matters** — the task's return value is captured
   by Trigger.dev as the run output and surfaces in the dashboard;
   pick something diagnostically useful (counts, ids, durations).

For the canonical example see the
[Schedule Dispatcher §2](../../agent-services/directory-schedule-dispatcher.md#where-it-runs).

## 4. The Three Shipped Tasks (today)

| Task                            | Trigger                             | Purpose                                                                       |
| ------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `directory-generation`          | Triggered (one-shot per generation) | Runs the full Standard / Agent / CLI-driven pipeline for a directory          |
| `directory-import`              | Triggered (one-shot per import)     | Awesome README import flow + post-processing                                  |
| `directory-schedule-dispatcher` | Cron (`*/N * * * *`)                | Polls due schedules and dispatches them; runs on every worker every N minutes |

`packages/tasks/src/tasks/trigger/index.ts` re-exports all three so
`trigger.config.ts` can register them with the Trigger.dev runtime.

Future tasks (cache cleanup, notification cleanup, OAuth-token
revalidation, billing retry) follow the same pattern — add a new file
under `tasks/trigger/`, export it from the index, deploy.

## 5. Cron vs One-Shot Tasks

| Style    | Trigger.dev primitive | Examples                                   |
| -------- | --------------------- | ------------------------------------------ |
| One-shot | `task(...)`           | `directory-generation`, `directory-import` |
| Cron     | `schedules.task(...)` | `directory-schedule-dispatcher`            |

The cron API takes a `cron: <expression>` field that Trigger.dev
converts into a managed schedule. The platform reads the **interval
in minutes** from `config.subscriptions.getDispatchIntervalMinutes()`
and computes the cron expression at module init:

```ts
const interval = Math.max(1, config.subscriptions.getDispatchIntervalMinutes());
const cronExpression = `*/${interval} * * * *`;
```

Trigger.dev guarantees **single firing per cron tick across the whole
worker pool** — but a slow tick can overlap the next tick. The
schedule dispatcher's CAS-claim pattern (see
[`agent-services/directory-schedule-dispatcher`](../../agent-services/directory-schedule-dispatcher.md))
handles the overlap case race-free.

## 6. The `TriggerInternalModule`

`packages/tasks/src/trigger/worker/modules/trigger-internal.module.ts`
is the **bootstrap-only** NestJS module the worker uses. It composes:

- `DatabaseModule` — same TypeORM data source as the API
- `MonitoringModule` — Sentry + PostHog wiring (see [`monitoring`](./monitoring.md))
- `CacheFactory.TypeORM(...)` — same `cache_entries` table
- `PluginsModule` — plugin registry + settings
- `FacadesModule` — every facade (AI, search, content extractor, deploy, screenshot, git, prompt)
- `DirectoryModule`, `ScheduleModule`, `ImportModule`, `ActivityLogModule`, `NotificationsModule`, `SubscriptionsModule` — the domain services tasks call

The module is **not** the same as the API's `AppModule`. It deliberately
omits HTTP-only concerns:

| Excluded                     | Why                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Controllers                  | Worker has no HTTP server                                                     |
| Global guards                | No requests to guard                                                          |
| Throttler                    | Tasks are rate-limited by Trigger.dev concurrency                             |
| WebSocket gateway            | Worker doesn't accept connections                                             |
| Email-sending HTTP endpoints | Workers can still _send_ email via `MailService`, just don't expose endpoints |
| MCP server bridge            | MCP runs in `apps/mcp`, not the worker                                        |

This split keeps worker memory low and rules out a class of bugs (e.g.
a request-scoped service accidentally captured in a long-running
task).

## 7. Logger Bridge

`createTriggerLogger(prefix)` returns a `LoggerService` shaped like
NestJS's logger but writing to Trigger.dev's run logger:

```ts
export function createTriggerLogger(prefix: string): LoggerService {
	return {
		log: (message, context) => triggerLogger.info(`[${prefix}${context ? ':' + context : ''}] ${message}`),
		error: (message, trace, context) =>
			triggerLogger.error(`[${prefix}${context ? ':' + context : ''}] ${message}`, { trace }),
		warn: (message, context) => triggerLogger.warn(`[${prefix}${context ? ':' + context : ''}] ${message}`),
		debug: (message, context) => triggerLogger.debug(`[${prefix}${context ? ':' + context : ''}] ${message}`),
		verbose: (message, context) => triggerLogger.debug(`[${prefix}${context ? ':' + context : ''}] ${message}`)
	};
}
```

This means **every** log line a service emits during a task run shows
up in the Trigger.dev dashboard's run-detail view, attached to the
right run, with the task prefix. Enormous debugging win — you don't
have to correlate run id with grep across the worker's stdout.

## 8. Error → Activity Log Mapping

When a task throws, Trigger.dev catches it, marks the run failed, and
surfaces the error in the dashboard. The platform also wants the
failure visible in the user-facing activity log. The pattern:

1. The task wraps the inner service call in `try/catch`.
2. On error, the task calls `directoryGenerationService.finalizeGeneration({outcome: 'failed', reason})` (or the equivalent for the operation type).
3. The finalize call writes both:
    - A `directory_generation_history` row with `status: ERROR`.
    - An `activity_log` row with `status: FAILED` and `details.runId` pointing at the Trigger.dev run id.
4. The task **re-throws** the original error so Trigger.dev still
   marks the run failed.

This dual-write means a single task failure produces:

- A user-visible "Generation failed" in the dashboard's History tab.
- A Sentry breadcrumb tagged with `triggerRunId`.
- A Trigger.dev dashboard entry with the full stack.

All three reference the same run id, so cross-pivoting between
Sentry / Trigger.dev / dashboard is trivial.

## 9. Run-Output Schema

Every task returns a structured object Trigger.dev captures. Conventions:

```ts
// Generation
{
    runId: string;
    directoryId: string;
    outcome: 'completed' | 'failed' | 'cancelled';
    durationMs: number;
    itemCount?: number;
    cost?: { inputTokens, outputTokens, usd };
}

// Schedule dispatcher
{
    intervalMinutes: number;
    limit: number;
    dueCount: number;
    dispatched: number;
    skipped: number;
    failed: number;
    entries: DirectoryScheduleDispatchEntry[];
}

// Import
{
    runId: string;
    directoryId: string;
    sourceType: 'data-repo' | 'awesome-readme' | 'link-existing';
    importedItemCount: number;
    durationMs: number;
}
```

This gives Trigger.dev enough to render summary lines in the dashboard
and lets ops grep for "every dispatcher tick that dispatched 0 jobs in
the last hour" without spelunking logs.

## 10. Cancellation

Trigger.dev exposes an `AbortSignal` via `ctx.signal` (in v4) or the
SDK's cancel API. The pattern in directory-generation:

1. The task captures `ctx.signal`.
2. Passes it through to the orchestrator.
3. The orchestrator threads it down to the executor's `StepContext.signal`.
4. Steps observe it during long operations (HTTP, AI calls).

See [`pipeline-executor §7`](./pipeline-executor.md) and
[`features/generation-cancellation/spec`](../features/generation-cancellation/spec.md)
for the user-facing model.

## 11. Concurrency & Queues

Trigger.dev queues tasks per-task-id by default. The platform
configures **per-organisation concurrency limits** so one user's
generation queue can't starve another's:

| Task                            | Concurrency limit             |
| ------------------------------- | ----------------------------- |
| `directory-generation`          | 5 per organisation, 50 global |
| `directory-import`              | 3 per organisation, 30 global |
| `directory-schedule-dispatcher` | 1 globally (cron-driven)      |

When a queue is full, additional submissions sit in `queued` state
until a slot frees. Trigger.dev surfaces queue depth in the dashboard.

## 12. Local Development

`pnpm dev:trigger` starts a local Trigger.dev dev server attached to
the worker. Tasks fire on demand (manually triggered from the
dashboard or by calling the API endpoints that dispatch them).

The dev server uses an isolated `dev` environment in the Trigger.dev
project; production runs in `prod`. Environment selection is via
`TRIGGER_API_URL` + `TRIGGER_SECRET_KEY` env vars.

## 13. Deployment

`pnpm deploy:trigger` (calls `turbo deploy:trigger`) bundles the
package and deploys to Trigger.dev's hosted runtime. CI runs this on
every push to `main` so the worker always matches the deployed API.

The Docker image at `.deploy/docker/api/Dockerfile` deliberately
**doesn't** include the trigger task code — the worker is hosted by
Trigger.dev, not in the same container as the API.

## 14. Constitution Reconciliation

| Principle                   | How the worker respects it                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| I — Plugin-first            | Tasks call into facades + plugin services through DI; never hardcode plugin ids.                  |
| II — Capability-driven      | Capability resolution happens in services the task uses; the task itself stays domain-agnostic.   |
| III — Source-of-truth repos | Generation tasks call `GitFacadeService` for every repo write; never raw Octokit.                 |
| IV — Trigger.dev            | This whole spec is the canonical site for Principle IV.                                           |
| V — Forward-only migrations | Tasks consume the same DB schema as the API; migrations bind both.                                |
| VI — Tests                  | Each task has a smoke test that bootstraps `TriggerInternalModule` and dispatches a fake payload. |
| VII — Secret hygiene        | Tasks use `PluginContext.settings` like every other consumer; never log raw values.               |
| VIII — Plugin counts        | The dispatcher's run output includes plugin counts so admin dashboards can read them.             |
| IX — Behaviour-first        | Run outputs describe observable outcomes.                                                         |
| X — Backwards-compat        | New tasks are additive; existing task ids stay stable.                                            |

## 15. References

- Source:
    - `packages/tasks/src/tasks/trigger/`
    - `packages/tasks/src/trigger/worker/`
    - `packages/tasks/trigger.config.ts`
- Related specs:
    - [`trigger-integration`](./trigger-integration.md) (overview)
    - [`agent-services/directory-schedule-dispatcher`](../../agent-services/directory-schedule-dispatcher.md)
    - [`pipeline-executor`](./pipeline-executor.md)
    - [`features/scheduled-updates/spec`](../features/scheduled-updates/spec.md)
    - [`features/generation-cancellation/spec`](../features/generation-cancellation/spec.md)
- User docs: [`docs/devops/trigger-dev.md`](../../devops/trigger-dev.md)
