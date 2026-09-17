import type { MemoryFactEmbedPayload } from './memory-fact-embed.types';

/**
 * AW-07 — the runtime-neutral half of the two memory-fact jobs.
 *
 * Every job-runtime provider hosts a job the same way underneath: it hands a
 * payload to a handler registered under a job id. Trigger.dev does it with
 * `task({ id, run })`, BullMQ and pg-boss with a worker-host
 * `register(queueName, handler)`, Inngest with a function, Temporal with an
 * activity. What differs is the registration call; what must NOT differ is
 * what the handler does. This file is that part — no runtime SDK, no Nest
 * container — so each provider's registration is a one-line adapter over it
 * and the behaviour stays identical whichever runtime the operator selects.
 *
 * The Trigger.dev tasks in `packages/tasks/src/tasks/trigger/memory-fact-*.task.ts`
 * delegate here; a pull-model runtime registers the same handler with its
 * own worker host (see `apps/api/src/memory-facts/memory-fact-embed.job-runtime.spec.ts`
 * for BullMQ and pg-boss).
 */

/** Job id / queue name of the one-shot embed job. Matches the Trigger.dev task id. */
export const MEMORY_FACT_EMBED_JOB_ID = 'memory-fact-embed';

/** Job id of the nightly sweep. Matches the Trigger.dev scheduled task id. */
export const MEMORY_FACT_GC_JOB_ID = 'memory-fact-gc';

/**
 * Cron of the nightly sweep: 04:13, offset off the hour and clear of the
 * other daily crons (see `memory-fact-gc.task.ts` for the neighbours).
 */
export const MEMORY_FACT_GC_CRON = '13 4 * * *';

/**
 * Same UUID shape the worker's `assertUuid` boundary check enforces, so a
 * payload refused on one runtime is refused on every runtime.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** What the embed handler calls — `MemoryFactEmbedService`, or an RPC proxy of it. */
export interface MemoryFactEmbedJobTarget<TOutcome> {
    embedFact(factId: string): Promise<TOutcome>;
}

/** What the sweep handler calls — `MemoryFactSweepService`, or an RPC proxy of it. */
export interface MemoryFactGcJobTarget<TSummary> {
    sweep(): Promise<TSummary>;
}

/**
 * Validate a `memory-fact-embed` payload at the runtime boundary. The fact id
 * is checked BEFORE it reaches a query or crosses an RPC channel, because a
 * queue payload is untrusted input on every runtime. `userId` is carried for
 * logs only (the row is re-read and is the authority), so it is passed
 * through as a string rather than gated.
 */
export function parseMemoryFactEmbedPayload(payload: unknown): MemoryFactEmbedPayload {
    const candidate = (payload ?? {}) as Partial<Record<keyof MemoryFactEmbedPayload, unknown>>;
    return {
        factId: assertJobUuid(candidate.factId, 'payload.factId'),
        userId: typeof candidate.userId === 'string' ? candidate.userId : '',
    };
}

/**
 * Run one `memory-fact-embed` job. Idempotent by construction: the service
 * skips an already-embedded body and a vector upsert replaces, so a retry or
 * a double enqueue on any runtime costs a no-op, never a second vector.
 *
 * An `unavailable` outcome (no AI provider / vector store yet) is RETURNED,
 * not thrown — the job acks and the nightly sweep embeds the fact later.
 */
export async function runMemoryFactEmbedJob<TOutcome>(
    payload: unknown,
    target: MemoryFactEmbedJobTarget<TOutcome>,
): Promise<TOutcome> {
    const { factId } = parseMemoryFactEmbedPayload(payload);
    return target.embedFact(factId);
}

/** Run one nightly `memory-fact-gc` pass. */
export async function runMemoryFactGcJob<TSummary>(
    target: MemoryFactGcJobTarget<TSummary>,
): Promise<TSummary> {
    return target.sweep();
}

function assertJobUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new Error(
            `Invalid ${field}: expected a UUID, got ${
                typeof value === 'string' ? JSON.stringify(value) : typeof value
            }`,
        );
    }
    return value;
}
