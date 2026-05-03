# ADR-002: Trigger.dev Worker → API Callback Channel

## Status

**Accepted** — Implemented

## Date

2026-05-02 (retrospective; the channel itself shipped earlier)

## Context

The platform splits long-running work generation into two
processes: the NestJS API and the Trigger.dev worker. The worker
runs the pipeline, the data generator, and the markdown / website
generators — every one of which needs database access (read work
config, write generation history, append logs, update plugin
settings, persist the items metrics).

The naive option is to give the worker the same DB connection string
the API has and let it touch the database directly. We considered
that and rejected it; this ADR records why and documents the
alternative we picked.

The full mechanism is described in
[`architecture/trigger-integration` §6](../architecture/trigger-integration.md#6-the-internal-api-callback-channel);
this ADR captures the **decision** rather than the implementation.

## Decision

The Trigger.dev worker **does not touch the platform database
directly**. Every repository or service in the worker that needs DB
access is provided as a **remote proxy** — a JavaScript `Proxy` object
that intercepts every method call, serialises the args with
SuperJSON, and forwards the call to a single allow-listed RPC
endpoint on the API.

Concretely:

1. The API exposes two endpoints under `/internal/trigger/`:
    - `GET /works/:id/context` — fetches a work plus its
      user plus a fresh git access token.
    - `POST /remote/call` — generic RPC: takes `{ name, method, args }`
      where `name` is one of an allow-listed set of provider names
      and `args` is a SuperJSON envelope. Returns
      `{ result: <SuperJSON envelope> }`.
2. Both endpoints require an `x-trigger-secret` header that matches
   `config.trigger.getInternalSecret()`. Both are decorated
   `@SkipThrottle({ short, medium, long })` because worker traffic
   bursts heavily.
3. The worker's NestJS modules bind every DB-touching service via
   `createRemoteProxy(apiClient, providerName)` so the orchestrator
   code reads as if it were running in-API.

The full allow-list of provider names is built in the API
controller's `onModuleInit` from injected providers — it cannot be
extended at runtime, so an attacker who guesses a class name cannot
reach it.

## Implementation Highlights

```ts
// packages/tasks/src/trigger/worker/remote-proxy.ts
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

```ts
// apps/api/src/trigger/trigger-internal.controller.ts
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
```

## Why this shape

### Why proxy instead of typed RPC

A typed RPC (tRPC, Connect, generated stubs) would give compile-time
safety on every call. We chose the runtime Proxy because:

- The set of methods proxied is **exactly the set of methods on the
  service classes** the API already owns. There's no second contract
  to maintain.
- Every new service we add to the worker is one DI binding line —
  no codegen step, no schema regeneration, no shared package version
  bump.
- TypeScript's structural typing already gives compile-time safety on
  the worker side because the binding declares the proxy as
  `WorkOperationsService`, etc.

The trade-off: typos in method names fail at runtime, not compile
time. We accept this because the worker code goes through the same
service interface the API uses, so any typo would also fail in API
unit tests.

### Why an allow-list instead of class-name → DI lookup

We considered building `remoteMap` from `moduleRef.get(name)` —
shorter code. We rejected it because that effectively gives the
worker (and anyone with the secret) `eval`-grade access to the API's
DI container. The hard-coded allow-list narrows the surface to the
exact set of services the worker is meant to touch.

### Why SuperJSON instead of plain JSON

The agent layer routinely passes:

- `Date` (history timestamps, schedule cadences)
- `Map` and `Set` (occasional plugin output)
- `BigInt` (rarely — token counters)
- `undefined` round-trips (some optional fields rely on
  `undefined !== null` semantics)

Plain JSON silently coerces these. SuperJSON sends a `{ json, meta }`
envelope so the receiver rehydrates the original shape. The cost
(~5% serialization overhead) is dominated by the network round-trip,
which already costs ~5ms.

### Why the worker doesn't connect to the DB directly

The seductive alternative would be: give the worker the same DB
connection string the API has and let it use TypeORM directly. We
rejected it for four reasons:

1. **Connection pool sizing.** A single DB has a finite connection
   budget. Having the API and N workers all connect concurrently
   makes pool sizing a multi-process puzzle. Funnelling through the
   API caps connection count to the API process pool's size.
2. **Audit hooks.** `ActivityLog` writes, ACL checks, and event
   emission live as side effects on top of the API's repositories.
   If the worker bypasses those, those side effects silently stop
   firing for any worker-driven mutation.
3. **Schema migrations.** Migrations roll out from `apps/api`. A
   worker connecting directly to the DB during a deploy would race
   the schema change. The callback channel pushes that race into the
   API process where Nest's `OnApplicationBootstrap` already
   serializes startup against migrations.
4. **Statelessness.** The worker has no DB connection of its own to
   leak, no migration state to corrupt on crash. Restarts and scale
   events don't require any DB-side coordination.

The cost — roughly 5ms per call instead of 0.5ms — is irrelevant for
operations that run a few times per pipeline step.

## Consequences

### Positive

- The worker is fully stateless. We can scale it to zero, restart it
  during a deploy, or run it on serverless without any DB-side
  coordination.
- All audit, ACL, and event-emission side effects run in exactly one
  place.
- Adding a new worker-side service is a one-line DI binding.
- The narrow attack surface (one secret, one allow-list, all
  `@SkipThrottle`) is auditable.

### Negative

- Per-call latency is ~5ms instead of ~0.5ms. A typical generation
  makes a few thousand calls, so adds ~10–30s on top of a 5–30 minute
  run. Acceptable.
- Compile-time safety on the proxy is structural rather than nominal
  — typos in method names fail at runtime.
- The API must be reachable from the worker. For air-gapped
  deployments (none today) we'd need a sidecar or a queue.

### Mitigations

- Retry-on-5xx with exponential backoff in `TriggerInternalApiClient`
  smooths over transient API restarts during long-running worker
  runs.
- Every endpoint on the controller is idempotent or last-writer-wins
  (history-row updates, repository upserts) so a retried call is
  safe.
- TypeScript binds the proxy as the original service interface,
  giving structural type safety on call sites.

## Alternatives Considered

### 1. Direct DB access from the worker

**Rejected** — see "Why the worker doesn't connect to the DB
directly" above.

### 2. tRPC / Connect / typed RPC

**Rejected for v1** — adds a codegen step and a shared package version
bump for every service signature change. The structural-typing
approach handles 95% of the safety story for none of the maintenance
cost. Worth revisiting if we ever ship a third callback consumer
(e.g. an MCP-side worker).

### 3. Message queue (NATS, BullMQ, AMQP)

**Rejected** — most worker → API calls are synchronous reads
(fetch work context, get plugin settings). A queue-based RPC
adds a hop and a correlation-id machinery without solving any
problem we have. We already use BullMQ + Trigger.dev for the
async-job parts.

### 4. Per-service REST endpoints

**Rejected** — would expand the API surface to ~30 internal
endpoints. The single generic RPC endpoint with allow-list is
narrower and easier to audit.

## Related

- [`architecture/trigger-integration`](../architecture/trigger-integration.md) §6 — full implementation walkthrough
- [`architecture/trigger-worker`](../architecture/trigger-worker.md) — worker bootstrap pattern
- [`architecture/database`](../architecture/database.md) — repository pattern the proxies mirror
- [`decisions/001-pipeline-checkpointing`](./001-pipeline-checkpointing.md)
