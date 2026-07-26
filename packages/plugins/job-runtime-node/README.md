# `@ever-works/job-runtime-node-plugin`

The `node` job-runtime provider. **The queue is the fleet.**

Every sibling runtime in this family wraps an external broker — Redis, Postgres,
a workflow server, a hosted queue. This one wraps the machines the owner enrolled
in **Fleet**: `enqueue` writes a lease-able `fleet_jobs` row, enrolled nodes poll
for it over the same outbound-only HTTP channel that enrollment and heartbeat
already use, and results come back the same way. No inbound port is ever opened
on a user's machine.

Before this plugin, a machine could enroll, heartbeat and show up in the Fleet
settings page, and nothing could ever be scheduled onto it. This is the piece
that turns that inventory into capacity.

## Contract parity

It implements the same `IJobRuntimeProvider` contract as the other providers, so
every existing selection path picks it up with **no special-casing**:

| Selection surface                | How `node` is chosen                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Instance selector                | `EVER_WORKS_JOB_RUNTIME=node`                                                                    |
| Tenant overlay                   | `tenant_job_runtime_config.providerId = 'node'` (deliberate `varchar(64)` — zero schema changes) |
| Operator allow-list              | `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS`                                                    |
| Job Runtime settings page        | one entry in `job-runtime-schemas.ts` + a provider icon                                          |
| Desktop installer runtime picker | one entry in `apps/desktop/src/shared/runtimes.ts`                                               |

## Lease protocol

```
  queued ──lease──▶ leased ──job heartbeat──▶ running ──complete──▶ done
     ▲                 │                          │              └▶ failed
     └─ lease expiry ──┴──────────────────────────┘   (attempts < maxAttempts)
```

A lease is a **deadline, not a lock**. If a node dies mid-job, nothing has to
notice: `leaseExpiresAt` passes and the work returns to the pool (or fails once
the attempt budget is spent). Reclaim runs both inline on every lease poll and on
a cron, so a fleet that stops polling entirely still converges.

Claiming is a conditional UPDATE pinned to `status = 'queued'`, so two nodes
racing the same row produce exactly one winner. Heartbeat and complete pin both
`nodeId` and the active statuses, so a node can never extend or finish another
node's job.

## Wiring (operator side, API process)

```ts
import { NodeJobRuntimePlugin, NodeDispatcherFactory } from '@ever-works/job-runtime-node-plugin';

const factory = new NodeDispatcherFactory({
	store: {
		enqueue: (req) => fleetJobService.enqueue(req),
		findById: (id) => fleetJobService.findViewById(id)
	}
});

const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(factory);
```

## Wiring (worker host, in-process)

```ts
import { NodeWorkerHostFactory } from '@ever-works/job-runtime-node-plugin';

const host = new NodeWorkerHostFactory({ transport, leaseTtlSec: 300 });
host.register('acceptance-checks', async (job) => runChecks(job.payload));

const handle = await plugin.useWorkerHostFactory(host).startWorkerHost({ concurrency: 2 });
process.on('SIGTERM', () => handle.stop());
```

A headless `apps/node` install runs the standalone equivalent of this loop
(`WorkerLoop` in `apps/node/src/core/worker-loop.ts`) — same protocol, same
backoff policy (both import `nextBackoffMs` semantics), no monorepo checkout
required.

## Capability targeting

`JobEnqueueOptions.tags` entries prefixed `cap:` become **scheduling
requirements**, not just observability labels: a node may only lease a job whose
every required tag is present in its own advertised capability set. Ordinary
tags pass through to the payload's reserved `_ew` namespace and never narrow
eligibility, so an observability tag can't accidentally strand a job on zero
nodes.

## Scheduling is deliberately a no-op

`registerSchedules` does nothing. Recurrence belongs to the platform's own cron:
anchoring a wall-clock schedule to a fleet of intermittently-online consumer
machines would silently elect "whichever node happened to be awake at 04:00" as
the only one that ever fires. Fleet jobs are enqueued _by_ those schedules, not
registered _with_ the fleet.

## Tenancy

`bindToTenant` returns an attribution view. There is no per-tenant broker to swap
because isolation here is **structural**: the lease query only ever returns a
node's own owner's work, enforced server-side rather than by a credential bag.
