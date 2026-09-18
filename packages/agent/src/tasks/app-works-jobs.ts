import { APP_SPEC_EVALUATION_TRIGGERS, type AppSpecEvaluationTrigger } from '@ever-works/contracts';
import type { AppSpecEvaluatePayload } from './app-spec-evaluate.types';

/**
 * APW-03 T13 — the runtime-neutral half of the App Works jobs, in the shape
 * `memory-fact-jobs.ts` established.
 *
 * Every job-runtime provider hosts a job the same way underneath: it hands a
 * payload to a handler registered under a job id. Trigger.dev does it with
 * `task({ id, run })`, BullMQ and pg-boss with a worker-host
 * `register(queueName, handler)`, Inngest with a function, Temporal with an
 * activity. What differs is the registration call; what must NOT differ is what
 * the handler does. This file is that part — no runtime SDK, no Nest container —
 * so each provider's registration is a one-line adapter over it and the
 * behaviour stays identical whichever runtime the operator selects.
 *
 * ## The in-process fallback is a property of ONE job id, and it lives here
 *
 * Plan §6.1:661-662 gives `app-spec-evaluate` an in-process fallback and the
 * other App Works jobs a `dispatchUnavailable` record instead, because
 * "a user is waiting on the page". That rule is data, not prose:
 * {@link APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS} is the list, and
 * {@link hasInProcessFallback} is the only way to ask. A second job added later
 * either joins that list deliberately (and inherits the API-process obligation
 * FR-90 describes) or it does not — it cannot inherit the behaviour by
 * accident, which is what a bare `if (jobId === 'app-spec-evaluate')` inside a
 * caller would allow.
 *
 * The sibling App Works jobs (`app-license-evaluate`, `app-blueprint-apply`,
 * `apps-catalog-refresh`) declare their ids beside this one as their own tasks
 * land; the list starts with the only job T13 owns.
 */

/**
 * Job id / queue name of the one-shot App spec evaluation. Matches the
 * Trigger.dev task id in `packages/tasks/src/tasks/trigger/app-spec-evaluate.task.ts`
 * and the `app-spec-evaluate` row of plan §6.1:650.
 */
export const APP_SPEC_EVALUATE_JOB_ID = 'app-spec-evaluate';

/**
 * The job ids a `null` dispatch runs **in-process** (plan §6.1:661-662).
 *
 * `app-spec-evaluate` is the whole list today. The other three App Works jobs
 * record `lastEvaluationError: 'dispatchUnavailable'` in their own services
 * instead, because nobody is waiting on a page for them.
 */
export const APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS: readonly string[] = [
    APP_SPEC_EVALUATE_JOB_ID,
] as const;

/**
 * Does a `null` dispatch of `jobId` mean "run it here", or "record that the
 * runtime is unavailable"? See {@link APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS}.
 */
export function hasInProcessFallback(jobId: string): boolean {
    return APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS.includes(jobId);
}

/** What the `app-spec-evaluate` handler calls — `AppSpecService`, or an RPC proxy of it. */
export interface AppSpecEvaluateJobTarget<TOutcome> {
    /** One full evaluation of one App Work. Never throws for a Work that is gone. */
    evaluate(workId: string): Promise<TOutcome>;
}

/** The payload a `app-spec-evaluate` message must carry — see {@link parseAppSpecEvaluatePayload}. */
export class AppSpecEvaluatePayloadError extends Error {
    readonly code = 'invalidAppSpecEvaluatePayload';

    constructor(message: string) {
        super(message);
        this.name = 'AppSpecEvaluatePayloadError';
    }
}

/**
 * Validate an `app-spec-evaluate` payload at the runtime boundary.
 *
 * A queue payload is untrusted input on every runtime, so the two fields the
 * handler acts on are checked **before** they reach a query: `workId` must be a
 * non-empty string (an empty one names no Work, and the service would read no
 * row and report a success that did not happen), and `trigger` must be one of
 * the closed set in `@ever-works/contracts` — a trigger the state column cannot
 * hold would be rejected by the database *after* the evaluation ran.
 *
 * The id is not required to be a uuid: the lookup is the authority (a
 * non-uuid simply matches no row, and the handler reports `no_state`), and a
 * shape check here would refuse a legitimate id from a future non-uuid Work
 * table without making the evaluation any safer.
 *
 * The four EW-742 binding fields pass through as-is: they are for the worker
 * host's credential resolution, they fail open, and none of them is a decision.
 */
export function parseAppSpecEvaluatePayload(payload: unknown): AppSpecEvaluatePayload {
    const candidate = (payload ?? {}) as Partial<Record<keyof AppSpecEvaluatePayload, unknown>>;

    const workId = typeof candidate.workId === 'string' ? candidate.workId.trim() : '';
    if (!workId) {
        throw new AppSpecEvaluatePayloadError(
            `Invalid payload.workId: expected a non-empty string, got ${
                typeof candidate.workId === 'string'
                    ? JSON.stringify(candidate.workId)
                    : typeof candidate.workId
            }`,
        );
    }

    const trigger = candidate.trigger;
    if (
        typeof trigger !== 'string' ||
        !(APP_SPEC_EVALUATION_TRIGGERS as readonly string[]).includes(trigger)
    ) {
        throw new AppSpecEvaluatePayloadError(
            `Invalid payload.trigger: expected one of ${APP_SPEC_EVALUATION_TRIGGERS.join(' | ')}, got ${
                typeof trigger === 'string' ? JSON.stringify(trigger) : typeof trigger
            }`,
        );
    }

    return {
        workId,
        trigger: trigger as AppSpecEvaluationTrigger,
        tenantId: typeof candidate.tenantId === 'string' ? candidate.tenantId : null,
        organizationId:
            typeof candidate.organizationId === 'string' ? candidate.organizationId : null,
        providerId: typeof candidate.providerId === 'string' ? candidate.providerId : null,
        credentialVersion:
            typeof candidate.credentialVersion === 'number' ? candidate.credentialVersion : null,
    };
}

/**
 * Run one `app-spec-evaluate` job.
 *
 * Idempotent by construction: the handler is `AppSpecService.evaluate`, which
 * takes the per-Work lock, writes under `evaluatedSeq < :seq` and emits only on
 * an effective-hash change — so a runtime retry, a duplicate delivery or an
 * in-process fallback racing a dispatched run costs a lost write, never a second
 * `app.spec.applied`. Nothing is swallowed here: a parse failure throws
 * {@link AppSpecEvaluatePayloadError} and a service failure propagates, so a
 * broken run is visible in the runtime's own run log rather than reported as a
 * success.
 */
export async function runAppSpecEvaluateJob<TOutcome>(
    payload: unknown,
    target: AppSpecEvaluateJobTarget<TOutcome>,
): Promise<TOutcome> {
    const { workId } = parseAppSpecEvaluatePayload(payload);
    return target.evaluate(workId);
}
