import type { FleetNodeView, NeedsALookItem } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01) — a "needs a look" producer (CONTRACTS §4.6, R-23).
 *
 * A producer reads facts its own epic owns and answers, for the computers it
 * is given, what a person should look at: FL-03 (disk low, throttled,
 * quarantined, consent missing, helper untrusted), FL-05 (a session needs
 * you), FL-13 (a schedule failing), FL-17 (an idle cloud computer), FL-18 (a
 * runner stopped, a job no runner can take), FL-02 (consents). FL-01 owns
 * this contract, the registry and the renderer, and ships no producer.
 *
 * Rules a producer keeps (the service enforces the ones it can):
 *  - answer ONLY for the nodes it was given — an item for any other node id
 *    is dropped, so a producer can never surface a machine the caller may
 *    not see;
 *  - each node carries `viewerRole` (the caller's role on it): a fact that is
 *    the owner's alone (a session's prompt, a path) is produced only when the
 *    role is `owner`;
 *  - never throw for one bad node — a throw drops this producer's whole
 *    answer for the request (it is logged, the response is marked partial,
 *    and every other producer still renders);
 *  - answer within {@link NEEDS_A_LOOK_PRODUCER_TIMEOUT_MS}; a slower answer
 *    is treated as a failure;
 *  - give each problem a stable `id` (per node, kind and subject), so the
 *    same problem keeps the same row across reads.
 */
export interface NeedsALookProducer {
    /** Stable id for logs (`fl-03.disk-low`). */
    readonly id: string;
    produce(
        nodes: readonly FleetNodeView[],
        context: NeedsALookContext,
    ): Promise<readonly NeedsALookItem[]> | readonly NeedsALookItem[];
}

export interface NeedsALookContext {
    /** The caller the list is for. */
    userId: string;
    /** One clock for the whole read, so every producer judges "stale" the same way. */
    now: Date;
}

/**
 * Optional DI token: bind it in `FleetModule` to an array of producers when a
 * static list is the clearer wiring. The usual wiring is
 * `NeedsALookService.register(this)` from a producer's `onModuleInit`, which
 * needs no edit here.
 */
export const NEEDS_A_LOOK_PRODUCERS = 'NEEDS_A_LOOK_PRODUCERS';

/** A producer that has not answered by now is skipped for this read. */
export const NEEDS_A_LOOK_PRODUCER_TIMEOUT_MS = 3_000;
