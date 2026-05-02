# Architecture: Event System

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers adding new domain events,
debugging missed event handlers, or extending the cross-module
notification surface.

---

## 1. Purpose

The platform uses **`@nestjs/event-emitter`** to decouple modules
that don't need synchronous coupling. A work creation, a
generation completion, or a `works.yml` sync request fires a typed
event; downstream consumers subscribe to it independently. The event
emitter is **in-process only** — there's no message broker, no Redis
pub/sub, no durable queue. For durable async work the platform uses
[`Trigger.dev`](./trigger-worker.md) instead.

This spec covers the **event base class**, the **registered event
catalogue**, the **emitter wiring**, **handler registration**,
**sync vs async execution**, and the **failure-handling model** for
event subscribers.

## 2. The `BaseEvent` Class

`packages/agent/src/events/base.ts`:

```ts
export abstract class BaseEvent {
	static EVENT_NAME: string;
}
```

That's the entire base. Concrete events extend it with:

```ts
import { BaseEvent } from './base';
import type { Work } from '@src/entities';

export class WorkCreatedEvent extends BaseEvent {
	static EVENT_NAME = 'work.created';

	constructor(public readonly work: Work) {
		super();
	}
}
```

Two conventions:

1. **Event names are dot-namespaced** — `<domain>.<action>` so
   wildcard subscribers can listen to `work.*`.
2. **The static `EVENT_NAME`** is the routing key; emitter calls and
   `@OnEvent` decorators all reference it via `MyEvent.EVENT_NAME`.

This pattern keeps event names **typed and refactor-safe**. Renaming
the static field updates every consumer at compile time. Free-form
strings would silently miss handlers on rename.

## 3. The Event Catalogue

The events shipped today (in
`packages/agent/src/events/`):

| Event                               | `EVENT_NAME`                     | When                                                     |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------- |
| `WorkCreatedEvent`             | `work.created`              | A new work has been persisted (any creation method) |
| `WorkGenerationCompletedEvent` | `work.generation.completed` | A pipeline run finished successfully                     |
| `WorksConfigSyncRequestedEvent`     | `works-config.sync.requested`    | A work mutation needs `works.yml` updated           |
| `WorksConfigSyncFailedEvent`        | `works-config.sync.failed`       | A `works.yml` sync write failed                          |

Future events follow the same shape — a class extending `BaseEvent`,
a static `EVENT_NAME`, a constructor capturing the relevant entities
or context.

## 4. Emitting Events

Producers inject NestJS's `EventEmitter2` and emit:

```ts
@Injectable()
export class WorkCreationService {
	constructor(private readonly events: EventEmitter2) {}

	async create(dto: CreateWorkDto): Promise<Work> {
		const work = await this.repository.save(dto);
		this.events.emit(WorkCreatedEvent.EVENT_NAME, new WorkCreatedEvent(work));
		return work;
	}
}
```

Two emit modes:

| Method                  | Behaviour                                                                  |
| ----------------------- | -------------------------------------------------------------------------- |
| `events.emit(...)`      | Sync — handlers run on the call stack; the emit call awaits all of them.   |
| `events.emitAsync(...)` | Async — handlers fire on the microtask queue; emitter returns immediately. |

The platform mostly uses `emit` (sync). When a handler does I/O it
returns a promise that the emitter awaits. This means:

- A handler that throws can break the emitter call **unless** the
  emitter is configured to swallow handler errors (it is — see §6).
- A slow handler (DB write, HTTP call) blocks the emitter call. For
  fan-out patterns where the producer doesn't care, use
  `emitAsync` or fire-and-forget the handler internally.

## 5. Subscribing to Events

Consumers register with NestJS's `@OnEvent` decorator:

```ts
@Injectable()
export class WorksConfigSyncSubscriber {
	constructor(private readonly worksConfigWriter: WorksConfigWriterService) {}

	@OnEvent(WorkGenerationCompletedEvent.EVENT_NAME)
	async onGenerationCompleted(event: WorkGenerationCompletedEvent): Promise<void> {
		try {
			await this.worksConfigWriter.writeToDataRepository({
				work: event.work,
				dataRepository: event.dataRepository
			});
		} catch (error) {
			this.events.emit(
				WorksConfigSyncFailedEvent.EVENT_NAME,
				new WorksConfigSyncFailedEvent(event.work, error)
			);
		}
	}
}
```

Subscribers are NestJS providers — they get DI like any other service
and live as singletons. Multiple subscribers can listen to the same
event; the emitter calls them in registration order.

## 6. Configuration

The platform configures `EventEmitterModule.forRoot(...)` at the app
root with these flags:

| Option              | Value  | Effect                                                  |
| ------------------- | ------ | ------------------------------------------------------- |
| `wildcard`          | `true` | Allows `work.*` style listeners                    |
| `delimiter`         | `.`    | Dot-separated event names                               |
| `maxListeners`      | 20     | Per-event soft cap; a warning logs at 80% capacity      |
| `verboseMemoryLeak` | `true` | Logs the event name when the listener cap is approached |
| `ignoreErrors`      | `true` | Handler errors don't bubble back to the emit call       |

The `ignoreErrors: true` setting is critical — without it, a single
broken handler crashes the producer. With it, errors surface only via
the handler's own logging (Sentry breadcrumbs, structured log lines).
This matches the platform's defence-in-depth posture.

## 7. Wildcard Listeners

The `wildcard: true` config means consumers can subscribe to a class
of events:

```ts
@OnEvent('work.*')
async onAnyWorkEvent(event: BaseEvent): Promise<void> {
    // Activity log captures every work.* event for audit
}
```

Used today by the activity-log dispatcher to catch every domain event
without per-event subscriptions. New events automatically flow through
without any wiring change.

## 8. Sync vs Async Decision Matrix

| Need                                         | Pattern                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| Producer must observe handler outcome        | `emit(...)` + handler returns a value                 |
| Producer must wait for handler to finish     | `emit(...)` + handler is async; emitter awaits        |
| Fan-out to many subscribers, fire-and-forget | `emitAsync(...)` or wrap in `setImmediate`            |
| Long-running work (>100 ms)                  | Don't use the event system; use Trigger.dev           |
| Cross-process coordination                   | Don't use the event system; use the DB or Trigger.dev |

The event system is for **in-process module decoupling**. Crossing
process boundaries is not its job — that's why
[`trigger-worker`](./trigger-worker.md) exists.

## 9. Pipeline Runtime Events

The pipeline executor (see
[`pipeline-executor`](./pipeline-executor.md)) uses the same emitter
to broadcast its `pipeline:state-changed` and
`pipeline:step-status-changed` events. These differ from domain
events:

- They use a **colon delimiter** (`:`) rather than dot — matches the
  runtime-events convention from `@ever-works/plugin/pipeline`.
- They fire many times per generation (every step transition).
- Subscribers are typically the activity-log writer + WebSocket gateway.

Both delimiters coexist because `delimiter: '.'` only affects
wildcard matching; literal event names with colons still route fine.

## 10. Event-Driven Read Models

Some platform features are implemented as event-sourced read models:

| Read model           | Source events                                               |
| -------------------- | ----------------------------------------------------------- |
| Activity log         | All `work.*` events + auth + plan events               |
| Notifications drawer | Subset of activity-log events that match `NotificationKind` |
| `works.yml` sync     | `work.generation.completed` → write back               |
| Cost reporting       | `pipeline:step-status-changed` with `aiUsage` accumulators  |

Each read model is a thin subscriber + writer. None of them update
shared state directly — they always go through their own service +
repository layer.

## 11. Failure Handling

Three failure modes:

### 11.1 Handler throws

With `ignoreErrors: true`, the emit call doesn't see the error. The
handler is responsible for logging it. The platform's convention:

```ts
try {
	await doTheWork(event);
} catch (error) {
	this.logger.error('Handler <name> failed for <event>', error);
	// Optionally emit a follow-up event (works-config.sync.failed pattern)
}
```

The handler **never** silently swallows errors — it always logs (and
ideally emits a compensating event).

### 11.2 Producer throws after emit

Sync handlers run before the producer returns. If the producer
throws **after** emitting an event but before its own work completes,
subscribers may have already run their side effects. The platform's
convention: **emit at the end of the producer's success path**, not
in the middle. This keeps emit semantically equivalent to "the work
is done."

### 11.3 Memory leak warning

The 20-listener soft cap fires a `MaxListenersExceededWarning`-style
log line when approached. Subscribers that register dynamically
(rare) need to call `removeListener` on shutdown. The platform's
NestJS providers are singletons that register once at boot, so this
is rarely an issue.

## 12. Testing

| Test pattern              | Setup                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| Subscriber unit test      | Construct subscriber + mock dependencies; invoke its handler directly |
| Producer + subscriber e2e | Boot the test module; emit; assert side effect                        |
| Wildcard listener test    | Subscribe to `work.*` and assert the right events fire           |

`@nestjs/event-emitter` exposes a real emitter in the test module —
no mocking is required for the emitter itself.

## 13. Constitution Reconciliation

| Principle                   | How the event system respects it                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| I — Plugin-first            | Plugins emit / subscribe via `PluginContext.events` (a thin wrapper around `EventEmitter2`). |
| II — Capability-driven      | Cross-module wiring goes through events rather than direct service injection.                |
| III — Source-of-truth repos | Events that affect repos go through `WorksConfigSyncRequested` → writer service.             |
| IV — Trigger.dev            | Long-running work spawned by event handlers uses `Trigger.dev`, not in-process work.         |
| V — Forward-only migrations | Event names are append-only; renaming is a two-release process.                              |
| VI — Tests                  | Per-subscriber unit tests + emit-and-assert e2e tests.                                       |
| VII — Secret hygiene        | Event payloads never include secret values; entities passed are filtered before emit.        |
| VIII — Plugin counts        | N/A.                                                                                         |
| IX — Behaviour-first        | This spec describes observable event behaviour.                                              |
| X — Backwards-compat        | New events + new subscribers are additive.                                                   |

## 14. References

- Source:
    - `packages/agent/src/events/`
    - `packages/agent/src/work-operations/work-operations.service.ts` (canonical emitter)
    - `packages/agent/src/pipeline/executable-pipeline.class.ts` (runtime events)
- Related specs:
    - [`pipeline-executor`](./pipeline-executor.md)
    - [`activity-log`](./activity-log.md)
    - [`features/works-config/spec`](../features/works-config/spec.md)
- User docs: [`docs/architecture/event-system.md`](../../architecture/event-system.md)
