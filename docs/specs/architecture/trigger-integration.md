# Architecture: Trigger.dev Integration

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers reasoning about how the API
hands long-running work off to Trigger.dev, why the platform splits
the API process from the worker process, and what the dispatch
contracts look like end-to-end.

---

## 1. Purpose

Long-running operations (work generation, Awesome README import,
scheduled dispatch) cannot run inside an HTTP request — they take
minutes to hours, must survive API redeploys, and need their own
resource budget. The platform delegates these to **Trigger.dev**:
the API enqueues a typed payload, Trigger.dev runs the task on its
own infrastructure, and the worker calls back into the API over a
narrow internal HTTP surface to read work state, write
generation history, and update plugin settings.

This spec covers the **integration story** — the dispatch path, the
payload contracts, the cross-process callback channel, the
configuration contract, the run lifecycle, and the operational
surface (cancellation, retries, monitoring). For the **internal task
package layout and bootstrap pattern**, see the companion
[`trigger-worker`](./trigger-worker.md) spec.

## 2. The Two-Process Split

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/api  (NestJS HTTP server)                                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ WorkGenerationService.startGeneration()               │  │
│  │   ├── Create WorkGenerationHistory row                │  │
│  │   ├── Build WorkGenerationPayload                     │  │
│  │   └── Call DIRECTORY_GENERATION_DISPATCHER.dispatch(...)   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                          │                                       │
│                          ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ TriggerService (packages/tasks/src/trigger/)               │  │
│  │   workGenerationTask.trigger(payload, { tags, ... })  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ TriggerInternalController (POST /internal/trigger/*)       │  │
│  │   - GET /works/:id/context                           │  │
│  │   - POST /remote/call  (SuperJSON envelope)                │  │
│  │   Auth: x-trigger-secret header                            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                          │  enqueue
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│  Trigger.dev cloud                                               │
│   - durable queue, retries, cancellation, dashboard              │
│   - one-shot tasks + cron schedules                              │
│   - machines: micro / small-Nx / medium-Nx / large-Nx            │
└──────────────────────────────────────────────────────────────────┘
                          │  run
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│  packages/tasks  (Trigger.dev worker process)                    │
│                                                                  │
│  workGenerationTask.run(payload)                            │
│    └── withWorkerContext(...)                                    │
│        ├── NestFactory.createApplicationContext(                 │
│        │       TriggerWorkerModule)                              │
│        ├── TriggerPluginHydratorService.initialize()             │
│        ├── createTaskContext(...) ── HTTP ──▶ internal API       │
│        └── TriggerGenerationOrchestrator.run({ ... })            │
│            ├── DataGeneratorService                              │
│            ├── MarkdownGeneratorService                          │
│            └── WebsiteGeneratorService                           │
│  Every repo/service that needs DB access is a Proxy that         │
│  forwards calls back to the API as SuperJSON envelopes.          │
└──────────────────────────────────────────────────────────────────┘
```

**Why split the processes?**

1. The API stays responsive during a 5-hour generation run.
2. The worker can be sized differently (`medium-1x` default,
   up to `large-2x`) without resizing every API instance.
3. Trigger.dev gives durable queueing, automatic retry, machine
   isolation, and a run dashboard — the platform doesn't reimplement
   any of that.
4. A worker crash never takes the API down with it.

**Why does the worker call _back_ to the API rather than touching the
DB directly?** It could in principle — the agent package supports it
— but the platform deliberately funnels every DB read/write through
the API process so that:

- One source of truth for connection-pool sizing.
- The API's audit hooks, ACL checks, and `ActivityLog` writes happen
  on every mutation regardless of caller.
- Schema migrations roll out from a single deployment unit.
- The worker stays stateless — restarts are safe.

The narrow callback surface (one read endpoint + one
generic-RPC endpoint) is described in §6.

## 3. Shipped Tasks

`packages/tasks/src/tasks/trigger/index.ts` ships exactly three tasks
on `develop`:

| Task                       | Type     | maxDuration | Purpose                                                        |
| -------------------------- | -------- | ----------- | -------------------------------------------------------------- |
| `work-generation`          | One-shot | 5 hours     | Full Standard / Agent / CLI pipeline run for a work            |
| `work-import`              | One-shot | 2 hours     | Awesome README / existing repo import + post-processing        |
| `work-schedule-dispatcher` | Cron     | (short)     | Polls due schedules every N minutes and dispatches generations |

Future cron tasks (cache cleanup, OAuth-token revalidation,
notification cleanup, source-validation cadence) follow the same
pattern.

## 4. Dispatch Contract

The agent package owns the **dispatcher interface** — the API wires
it up, the worker package implements it. This keeps the API free of
any direct Trigger.dev SDK dependency:

```ts
// packages/agent/src/tasks/work-generation-dispatcher.ts
export interface WorkGenerationDispatcher {
	dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null>;
	cancelWorkGeneration(runId: string): Promise<boolean>;
}

export const DIRECTORY_GENERATION_DISPATCHER = Symbol('DIRECTORY_GENERATION_DISPATCHER');
```

`packages/tasks/src/trigger/trigger.module.ts` provides the binding:

```ts
@Global()
@Module({
	providers: [
		TriggerService,
		{ provide: DIRECTORY_GENERATION_DISPATCHER, useExisting: TriggerService },
		{ provide: DIRECTORY_IMPORT_DISPATCHER, useExisting: TriggerService }
	],
	exports: [TriggerService, DIRECTORY_GENERATION_DISPATCHER, DIRECTORY_IMPORT_DISPATCHER]
})
export class TriggerModule {}
```

`TriggerService` itself is small — it lazy-configures the Trigger.dev
SDK and forwards to the task handle:

```ts
async dispatchWorkGeneration(payload: WorkGenerationPayload) {
    if (!this.ensureConfigured()) return null;          // dev-mode escape hatch
    const handle = await workGenerationTask.trigger(payload, {
        tags: ['work-generation', payload.mode, payload.workId],
        machine: this.machine() as any,
    });
    return handle.id;
}
```

When `TRIGGER_SECRET_KEY` is missing or `config.trigger.shouldUseTrigger()`
returns false, dispatch returns `null` — the API treats this as
"Trigger.dev is not enabled in this environment" and either runs the
work in-process (dev) or surfaces a friendly error (prod). This
makes Trigger.dev opt-in per environment without code-level branching.

## 5. Payload Contracts

Every payload is plain JSON. Trigger.dev serializes it for the queue,
so no `Date`, no `Buffer`, no class instances.

### 5.1 `WorkGenerationPayload`

```ts
// packages/agent/src/tasks/work-generation.types.ts
export type WorkGenerationPayload = {
	workId: string; // UUID
	userId: string; // UUID of user who triggered
	mode: 'create' | 'update'; // CREATE = first run; UPDATE = subsequent
	dto: CreateItemsGeneratorDto; // Step inputs (categories, tags, prompts, etc.)
	historyId: string; // UUID — pre-created GenerationHistory row
	historyStartedAt?: string; // ISO timestamp (resilient against retries)
	triggerSource?: 'user' | 'schedule' | 'api';
	scheduleId?: string; // Set when triggerSource === 'schedule'
};
```

Tags written to the run: `['work-generation', mode, workId]`.

### 5.2 `WorkImportPayload`

```ts
// packages/agent/src/tasks/work-import.types.ts
export type WorkImportPayload = {
	workId: string;
	userId: string;
	sourceUrl: string;
	sourceOwner: string;
	sourceRepo: string;
	sourceType: ImportSourceType; // 'awesome' | 'work' | 'data-only' | ...
	historyId: string;
	historyStartedAt?: string;
	triggerSource?: 'user' | 'schedule' | 'api';
	options?: {
		createMissingRepos?: boolean;
		enableSync?: boolean;
	};
	providers?: ProvidersDto; // Per-import plugin overrides
	enrichmentConfig?: ImportEnrichmentConfigDto;
	worksConfig?: ResolvedWorksConfig | null;
};
```

Tags: `['work-import', sourceType, workId]`.

### 5.3 Why a pre-created `historyId`?

The API creates the `WorkGenerationHistory` row **before**
dispatch and passes its UUID into the payload. Both ends rely on
this:

- The API can show "queued" state immediately (before the worker
  even claims the run).
- Retries write to the same row (Trigger.dev re-runs receive the
  same payload).
- `onFailure` / `onCancel` handlers can mark the row terminal even
  if the worker never reached the orchestrator's main `run`.

`historyStartedAt` is similarly pre-stamped so duration calculations
are stable across retries.

## 6. The Internal API Callback Channel

The worker doesn't touch the DB directly. Instead, every repository
or service that needs DB access is provided as a **remote proxy**
that forwards calls to the API over an internal HTTP endpoint.

### 6.1 The proxy mechanism

```ts
// packages/tasks/src/trigger/worker/remote-proxy.ts (essentials)
export function createRemoteProxy(apiClient, providerName, localMethods?) {
	const target = localMethods ?? {};
	return new Proxy(target, {
		get(obj, prop) {
			if (typeof prop === 'symbol' || PASSTHROUGH.has(prop)) return undefined;
			if (prop in obj) return obj[prop]; // local short-circuit
			return (...args) => {
				const serialized = superjson.serialize(args);
				return apiClient.callRemote(providerName, prop, serialized);
			};
		}
	});
}
```

Worker DI bindings look like:

```ts
{
    provide: WorkOperationsService,
    useFactory: (apiClient: TriggerInternalApiClient) =>
        createRemoteProxy(apiClient, 'WorkOperationsService'),
    inject: [TriggerInternalApiClient],
},
```

The orchestrator code is identical to in-API code — `await
this.workOperations.recordGenerationStartTime(...)` — but every
call is a SuperJSON-enveloped HTTP POST under the hood. The
`PluginRepository` binding extends this with a `LocalPluginStore` for
write-only methods (`create`, `upsert`, `update`, `delete`,
`updateState`); reads still fall through to the remote proxy. This
lets the worker bootstrap plugins from the filesystem locally without
inventing two repository contracts.

`AuthAccountRepository` is provided with `isAccessTokenExpired`
implemented locally (a sync `Date` comparison) — calling the API for
that would be wasteful and pointless.

### 6.2 The API endpoint

`apps/api/src/trigger/trigger-internal.controller.ts` exposes the two
endpoints the worker hits:

```ts
@SkipThrottle({ short: true, medium: true, long: true })
@Controller('internal/trigger')
export class TriggerInternalController implements OnModuleInit {
	private remoteMap: Record<string, object> = {};

	onModuleInit() {
		this.remoteMap = {
			AuthAccountRepository: this.authAccountRepository,
			PluginRepository: this.pluginRepository,
			UserPluginRepository: this.userPluginRepository,
			WorkPluginRepository: this.workPluginRepository,
			WorkOperationsService: this.workOperationsService,
			NotificationService: this.notificationService,
			WorkRepository: this.workRepository,
			CacheManager: this.cacheManager,
			WorkScheduleDispatcherService: this.scheduleDispatcher,
			WorkScheduleService: this.workScheduleService
		};
	}

	@Get('works/:id/context')
	@Public()
	async getWorkContext(@Headers('x-trigger-secret') secret, @Param('id') id, @Query('userId') userId) {
		this.ensureSecret(secret);
		const { work } = await this.ownershipService.ensureAccess(id, userId);
		const gitToken = await this.gitFacade.getAccessToken({ userId, providerId: work.gitProvider });
		return { work: stripRelations(work), user: stripSensitiveUserData(work.user), gitToken };
	}

	@Post('remote/call')
	@Public()
	async callRemote(@Headers('x-trigger-secret') secret, @Body() body: RemoteCallDto) {
		this.ensureSecret(secret);
		const instance = this.remoteMap[body.name];
		if (!instance) throw new BadRequestException(`Unknown remote target: ${body.name}`);
		const fn = (instance as any)[body.method];
		if (typeof fn !== 'function') throw new BadRequestException(`Unknown method: ${body.method}`);
		const args = superjson.deserialize(body.args as any) as unknown[];
		const result = await fn.call(instance, ...args);
		return { result: superjson.serialize(result) };
	}
}
```

Three properties make this safe:

1. **Allow-list, not reflection.** `remoteMap` is built from injected
   providers in `onModuleInit` — only those names are callable. There
   is no string→class lookup against the DI container; an attacker
   who guesses a class name cannot reach it.
2. **`x-trigger-secret` shared header.** Both sides read
   `config.trigger.getInternalSecret()` from env. The constructor
   throws on missing secret in the worker, the controller throws
   `ForbiddenException` on missing or wrong secret in the API.
3. **`@SkipThrottle` everywhere on the controller.** Worker calls can
   burst (a single generation makes thousands of remote calls) so
   normal user throttling would starve them. The secret takes the
   place of rate limiting on this endpoint.

### 6.3 The client side

`TriggerInternalApiClient` is a thin `fetch` wrapper with
exponential-backoff retry on 5xx and network errors:

```ts
private async request<T>({ method, path, body }) {
    const url = this.composeUrl(path);
    const maxRetries = 3;
    const baseDelayMs = 500;
    // ... try/catch with retry + 5xx-only retry condition
}
```

Retries here matter: a worker run is long-lived and a transient API
restart should not fail the entire generation. Retries on 5xx +
network errors are safe because every endpoint on the controller is
either idempotent (reads) or already idempotent at the service layer
(repository upserts, `updateGenerateStatus` overwrites, history-row
`finishedAt` writes are last-writer-wins).

### 6.4 SuperJSON, not JSON

The internal channel uses [SuperJSON](https://github.com/blitz-js/superjson)
because the agent layer routinely passes:

- `Date` (history timestamps, schedule cadences)
- `Map` and `Set` (occasional plugin output)
- `BigInt` (rarely — token counters)
- `undefined` round-trips (some optional fields rely on
  `undefined !== null` semantics)

Plain JSON would silently coerce these. SuperJSON sends a
`{ json, meta }` envelope so the receiver can rehydrate the original
shape.

## 7. Run Lifecycle

```
   API: startGeneration
        │
        │  create WorkGenerationHistory(historyId, NOT_STARTED)
        │  build WorkGenerationPayload
        │
        │  TRIGGER_SECRET_KEY?  ──no──▶ in-process fallback (dev only)
        │           │
        │          yes
        │           ▼
        │   triggerService.dispatchWorkGeneration(payload)
        │     └── workGenerationTask.trigger(payload, { tags, machine })
        │          ▲
        │          │ returns runId
        │          │
        │   API stores runId on the history row              ┐
        │                                                    │
        │                                                    ▼
        ▼                                       Trigger.dev queue & schedule
   API returns 202 / streaming status                        │
                                                             ▼
                                                    Worker picks up run
                                                             │
                                                             ▼
                                              withWorkerContext('WorkGeneration', ...)
                                                             │
                                            ┌───── orchestrator.run({ ... }) ─────┐
                                            │                                      │
                                            ▼                                      ▼
                                     SUCCESS                              ERROR or CANCEL
                                            │                                      │
                                  GENERATED ◀─orchestrator writes ▶  ERROR / CANCELLED
                                            │                          │
                                  (run output JSON)         onFailure / onCancel re-bootstraps
                                            │                a fresh app context to write
                                            ▼                terminal state and emit events
                                  Trigger.dev marks run completed
```

Three classes of terminal write keep this consistent:

| Where written         | What it sets                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- |
| Orchestrator main run | Success path: `GENERATED` on work + history; warnings + recent logs; stats deltas   |
| Orchestrator catch    | Cancel path: `CANCELLED`; Error path: `ERROR` + `errorMessage` + recent logs        |
| Task `onFailure` hook | Last-resort `ERROR` write if the orchestrator itself crashed before its `catch` ran |
| Task `onCancel` hook  | Last-resort `CANCELLED` write if Trigger.dev cancels mid-orchestration              |

The `BaseOrchestrator` exposes `handleFailure` and `handleCancellation`
so both paths converge on the same `recordTerminalState` Promise.all
(work status + history status + finishedAt + duration). The
task hooks call into those when payload context is available even
after a fatal exception.

## 8. Cancellation

Cancellation is a four-step dance:

1. User calls `DELETE /api/works/:id/generation`.
2. The API looks up the latest history row, reads `triggerTaskId`,
   and calls `triggerService.cancelWorkGeneration(runId)`, which
   forwards to `runs.cancel(runId)` from `@trigger.dev/sdk`.
3. Trigger.dev sends an `AbortSignal` into the running task and
   triggers the task's `onCancel` hook.
4. The orchestrator's `run` method sees `signal.aborted === true`
   at the next `throwIfGenerationCancelled(signal)` checkpoint and
   throws `GENERATION_CANCELLED`. Its `catch` writes `CANCELLED` to
   the work + history row.

The signal is threaded through pipeline steps, so cancellation
propagates into in-flight AI / search / git calls — most of which
also accept `AbortSignal`.

If the orchestrator's main path crashes before observing the abort,
`onCancel` re-bootstraps an app context and writes `CANCELLED`
itself. If both fail, `onFailure` writes `ERROR` as a last resort.
This three-layer defense prevents `GENERATING` rows from getting
stuck.

For the scheduled-source case (`triggerSource === 'schedule'`), a
cancelled run also calls `scheduleService.markRunFailed(scheduleId,
'cancelled')` so the scheduler's failure-counter and next-run cadence
remain accurate.

## 9. Retry Configuration

Retries default to **off** to keep behaviour predictable: a partial
generation should fail loudly, not silently retry, because most
failures (rate limit, plugin misconfig, repo permission) won't
resolve themselves on a re-run. Set
`TRIGGER_DEV_ENABLE_RETRIES=true` to opt in:

```ts
// packages/tasks/trigger.config.ts
const canRetry = process.env.TRIGGER_DEV_ENABLE_RETRIES === 'true';

retries: canRetry
	? {
			enabledInDev: true,
			default: {
				maxAttempts: 3,
				minTimeoutInMs: 1000,
				maxTimeoutInMs: 10000,
				factor: 2,
				randomize: true
			}
		}
	: undefined,
```

When retries _are_ enabled, the pre-created `historyId` and
`historyStartedAt` ensure each retry writes to the same row with a
stable start time. Pipeline checkpointing
(`docs/specs/decisions/001-pipeline-checkpointing.md`) means a
retried run resumes from the last completed step rather than
restarting the full pipeline.

## 10. Cron: Scheduled Dispatcher

`workScheduleDispatcherTask` is the only cron task today. It
fires on a configurable cadence:

```ts
// packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts
const interval = Math.max(1, config.subscriptions.getDispatchIntervalMinutes());
const cronExpression = `*/${interval} * * * *`;

export const workScheduleDispatcherTask = schedules.task({
	id: 'work-schedule-dispatcher',
	cron: cronExpression,
	run: async () => {
		const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
		appContext.useLogger(createTriggerLogger('ScheduleDispatcher'));
		try {
			const dispatcher = appContext.get(WorkScheduleDispatcherService);
			const summary = await dispatcher.dispatchDue();
			return { intervalMinutes: interval, ...summary };
		} finally {
			await appContext.close();
		}
	}
});
```

The dispatcher uses `TriggerInternalModule` (a much thinner module
than `TriggerWorkerModule` — see [`trigger-worker`](./trigger-worker.md))
because it only needs the schedule service and its plain-DB
dependencies.

A CAS-style `UPDATE` claim inside `WorkScheduleDispatcherService.dispatchDue`
keeps multiple worker firings race-free; see
[`features/scheduled-updates`](../features/scheduled-updates/spec.md)
for the claim contract. That makes Trigger.dev's "single firing per
cron tick" guarantee a useful default but not a load-bearing one.

## 11. Plugin Hydration

The worker is **stateless** between runs but the work generation
pipeline is plugin-driven (15-step Standard pipeline, plus
agent-based / CLI-based / external-platform pipelines). On every
run, the worker:

1. Bootstraps the app context (`TriggerWorkerModule`).
2. Calls `TriggerPluginHydratorService.initialize()`, which delegates
   to `PluginBootstrapService.bootstrap({ force: true })` — discovers
   manifests under `./plugins/`, registers them in the
   `PluginRegistryService`, applies last-known settings.
3. Resolves the work + user via the internal API and calls the
   chosen orchestrator.

Plugin _settings_ (the secret hygiene-sensitive part) come down via
the remote proxy from the API's `PluginSettingsService`, ensuring the
worker never has its own settings copy that could drift.

Plugin _code_ is bundled into the Trigger.dev deployment by the
`trigger.config.ts` build extensions:

```ts
build: {
    extensions: [
        emitDecoratorMetadata(),                     // TypeORM decorators
        additionalFiles({ files: ['./plugins/**'] }),// built plugin artifacts
        additionalPackages({ packages: collectPluginDependencies() }),
    ],
},
```

`collectPluginDependencies()` reads each plugin's `package.json`,
unions the `dependencies` lists, and feeds them to the Trigger.dev
build so its Node container has everything plugins need without
mutating root `package.json`.

## 12. Configuration Contract

```bash
# Trigger.dev cloud
TRIGGER_SECRET_KEY=tr_dev_xxx              # API key (required to enable dispatch)
TRIGGER_API_URL=https://api.trigger.dev    # Override for self-hosted Trigger.dev
TRIGGER_MACHINE=medium-1x                  # Default run machine
TRIGGER_DEV_ENABLE_RETRIES=false           # Opt-in retry behaviour

# Internal callback channel
TRIGGER_INTERNAL_API_URL=http://api:3100/api  # Worker → API base URL
TRIGGER_INTERNAL_SECRET=<random-32-bytes>     # Shared secret for x-trigger-secret
```

`config.trigger.shouldUseTrigger()` reads these and returns false
in development by default; that path runs everything in-process for
quick iteration. `pnpm dev:trigger` starts the local Trigger.dev dev
server and switches workers on without touching the API.

The supported machines are pinned in `TriggerService`:

```ts
private supportedMachines = [
    'medium-1x',
    'micro',
    'small-1x',
    'small-2x',
    'medium-2x',
    'large-1x',
    'large-2x',
];
```

If `TRIGGER_MACHINE` is set to anything outside this list the service
silently drops the override and uses the task's `trigger.config.ts`
default (`medium-1x`). This is intentional: Trigger.dev rejects
unknown machine names with a hard error and we'd rather degrade
gracefully than fail dispatch.

## 13. Operational Surface

| Concern        | Where to look                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Run logs       | Trigger.dev dashboard (logger bridge surfaces every NestJS log line as run-scoped)                    |
| Run status     | `WorkGenerationHistory` (status, error, recentLogs, durationInSeconds)                                |
| User-facing UI | `apps/web` work page streams `recentLogs` + status from the history row                               |
| Sentry events  | Worker process emits via the same MonitoringModule the API uses (see [`monitoring`](./monitoring.md)) |
| PostHog events | `event.generation.completed` / `.failed` / `.cancelled` from `workOperations`                         |
| Manual cancel  | `DELETE /api/works/:id/generation` → `runs.cancel(runId)`                                             |
| Run dashboard  | `https://cloud.trigger.dev/orgs/.../projects/proj_uevrbfmpvojzzazvhffy/runs`                          |

## 14. File Index

```
apps/api/src/trigger/
├── trigger-internal.module.ts        # Wires all proxied services
├── trigger-internal.controller.ts    # /internal/trigger/* endpoints
└── dto/remote-call.dto.ts            # SuperJSON envelope DTO

packages/agent/src/tasks/
├── work-generation.types.ts             # Payload + WorkContextResponse
├── work-import.types.ts                 # Import payload + result + error codes
├── work-generation-dispatcher.ts        # DI symbol + interface
└── work-import-dispatcher.ts            # DI symbol + interface

packages/tasks/
├── trigger.config.ts                                       # Trigger.dev project config
└── src/
    ├── build/collect-plugin-deps.ts                        # Plugin deps for the worker bundle
    ├── trigger/
    │   ├── trigger.module.ts                               # @Global TriggerModule
    │   └── trigger.service.ts                              # Dispatcher implementation
    └── tasks/trigger/
        ├── work-generation.task.ts                    # One-shot task definition
        ├── work-import.task.ts                        # One-shot task definition
        ├── work-schedule-dispatcher.task.ts           # Cron task definition
        └── index.ts                                        # Task registry
```

## 15. See Also

- [`trigger-worker`](./trigger-worker.md) — task package layout,
  per-task NestJS bootstrap, logger bridge, plugin hydration internals
- [`pipeline-overview`](./pipeline-overview.md) — what
  `DataGeneratorService` does once the orchestrator hands off to it
- [`features/scheduled-updates`](../features/scheduled-updates/spec.md) —
  CAS-claim contract for the cron dispatcher
- [`features/generation-cancellation`](../features/generation-cancellation/spec.md) —
  full cancellation lifecycle including UI states
- [`decisions/001-pipeline-checkpointing.md`](../decisions/001-pipeline-checkpointing.md) —
  why checkpointing matters for retries
- [`monitoring`](./monitoring.md) — Sentry / PostHog wiring shared
  by the API and the worker
