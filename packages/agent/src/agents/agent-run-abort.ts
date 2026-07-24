import {
    createGenerationCancelledError,
    throwIfGenerationCancelled,
} from '../utils/generation-cancellation.utils';

/**
 * Cooperative cancellation source for an in-flight AgentRun.
 *
 * Combines the two ways a run learns it was cancelled, so call sites have one
 * checkpoint API and neither source is special-cased:
 *
 *  1. **Trigger.dev's `AbortSignal`** — the primary path. Delivered to every
 *     task `run()` and aborted when the run is cancelled, so it is free,
 *     instant, and needs no I/O.
 *  2. **A throttled read of the AgentRun status** — the fallback. The DB row is
 *     the authoritative cancel, and there are real windows where it says
 *     `cancelled` but the signal never fires: `AgentRunCanceller` returned
 *     `'failed'` (transient error reaching the Trigger.dev API, or an id it
 *     does not recognise), or `triggerRunId` was still NULL when the cancel
 *     arrived so there was nothing to call `runs.cancel()` on.
 *
 * `checkpoint()` short-circuits on the signal and never touches the DB when it
 * is already aborted, so the common case costs zero queries.
 */
export interface AgentRunAbortSource {
    /** Latched, synchronous, no I/O. True once either source has reported cancel. */
    readonly aborted: boolean;
    /** The underlying signal, for threading into downstream HTTP/model calls. */
    readonly signal?: AbortSignal;
    /** Signal-only and synchronous. Throws the canonical AbortError. For hot inner loops. */
    throwIfAborted(): void;
    /** Signal plus a throttled status read. Throws the canonical AbortError. */
    checkpoint(): Promise<void>;
}

export interface CreateAgentRunAbortSourceOptions {
    runId: string;
    /** Trigger.dev's run signal. Absent in tests and when a run executes outside a task. */
    signal?: AbortSignal;
    /**
     * Narrow status reader, deliberately a function rather than the whole
     * repository, so this stays a pure unit with no DB import.
     */
    readStatus?: (runId: string) => Promise<string | null>;
    /**
     * Minimum wall-clock gap between status reads. Defaults to 0 — check on
     * every checkpoint.
     *
     * A wall-clock throttle looks prudent but buys nothing here and costs
     * responsiveness: the caller checkpoints once per model round-trip and the
     * tool loop is capped at 10 iterations, so the ceiling is already ≤10
     * primary-key SELECTs per run — against a run making 10 LLM calls. A
     * non-zero default would also silently skip the fallback entirely whenever
     * rounds return faster than the window, which is exactly when a cancelled
     * run burns the most iterations.
     */
    minDbIntervalMs?: number;
    /** Test seam. */
    now?: () => number;
}

const DEFAULT_MIN_DB_INTERVAL_MS = 0;

export function createAgentRunAbortSource(
    opts: CreateAgentRunAbortSourceOptions,
): AgentRunAbortSource {
    const { runId, signal, readStatus, now = () => Date.now() } = opts;
    const minDbIntervalMs = opts.minDbIntervalMs ?? DEFAULT_MIN_DB_INTERVAL_MS;

    // Latched: once cancelled, always cancelled. Prevents a flaky status read
    // from un-cancelling a run we already decided to stop.
    let latched = false;
    let lastReadAt: number | null = null;

    const isAborted = () => latched || Boolean(signal?.aborted);

    return {
        get aborted() {
            return isAborted();
        },
        get signal() {
            return signal;
        },
        throwIfAborted() {
            if (latched) throw createGenerationCancelledError();
            throwIfGenerationCancelled(signal);
        },
        async checkpoint() {
            // Signal first: when it works, the DB is never read.
            if (latched) throw createGenerationCancelledError();
            throwIfGenerationCancelled(signal);
            if (!readStatus) return;

            const at = now();
            if (lastReadAt !== null && at - lastReadAt < minDbIntervalMs) return;
            lastReadAt = at;

            // A failing status read must not fail an otherwise-healthy run —
            // the signal remains the primary path. try/catch rather than
            // `.catch()`: readStatus can throw SYNCHRONOUSLY (a repository
            // stub without the method, a null deref building the query), and a
            // `.catch()` never attaches in that case, so the throw would escape
            // and be misreported as a dispatch failure.
            let status: string | null = null;
            try {
                status = await readStatus(runId);
            } catch {
                return;
            }
            // `failed` counts as a stop signal too, not just `cancelled`: the
            // stuck-run sweeper reaps abandoned rows to `failed`, and if it
            // ever lands on a worker that is somehow still alive, that worker
            // must bail here rather than run to completion and then discover
            // its terminal write no-ops against the CAS — having already
            // applied the side effects.
            if (status === 'cancelled' || status === 'failed') {
                latched = true;
                throw createGenerationCancelledError();
            }
        },
    };
}
