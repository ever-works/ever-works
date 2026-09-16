import {
    CONNECTION_CREDENTIAL_ERROR_CODES,
    CONNECTION_UNREACHABLE_AFTER_FAILURES,
    isConnectionHealthErrorCode,
    type ConnectionHealth,
    type ConnectionHealthErrorCode,
} from '@ever-works/contracts';

/**
 * Connection health (AW-15) — the PURE classifier.
 *
 * Turns the outcome of one real connection attempt into a health state,
 * independent of which kind of connection made it. Side-effect free so every
 * branch is a unit test, and so any later probe (a scheduled check, another
 * connection kind) lands on the same rules instead of re-deriving them.
 *
 *   success                          → healthy, failure count reset to 0
 *   success carrying a warning       → the warning state (today only
 *     (`insecure_transport`)            `insecure_transport`), count reset to 0.
 *                                       A warning is a WORKING connection: it is
 *                                       never expired and never blocks anything.
 *   credential rejected / missing /
 *   refused on plain http            → expired immediately (retrying fixes nothing)
 *     (`https_required`)
 *   anything else, 1–2 in a row      → degraded
 *   anything else, 3+ in a row       → unreachable
 *
 * The result carries a CODE only. The human-readable message a connection
 * already stores is the caller's classified text; a raw provider response body
 * never passes through here.
 */

export interface ConnectionProbeOutcome {
    ok: boolean;
    /** Classified reason for a failure. Unknown / absent ⇒ `failed`. */
    errorCode?: ConnectionHealthErrorCode | string | null;
    /**
     * A successful attempt the owner should still hear about. Only codes in
     * `CONNECTION_HEALTH_WARNING_CODES` count; anything else is ignored and
     * the success stays `healthy`.
     */
    warning?: ConnectionHealthErrorCode | string | null;
}

export interface ClassifiedConnectionHealth {
    health: ConnectionHealth;
    /** `null` on success. */
    errorCode: ConnectionHealthErrorCode | null;
    /** Consecutive failed attempts, including this one. `0` on success. */
    failureCount: number;
}

export function classifyProbeResult(
    outcome: ConnectionProbeOutcome,
    previousFailureCount = 0,
): ClassifiedConnectionHealth {
    if (outcome.ok) {
        if (outcome.warning === 'insecure_transport') {
            return {
                health: 'insecure_transport',
                errorCode: 'insecure_transport',
                failureCount: 0,
            };
        }
        return { health: 'healthy', errorCode: null, failureCount: 0 };
    }

    const previous =
        Number.isFinite(previousFailureCount) && previousFailureCount > 0
            ? Math.floor(previousFailureCount)
            : 0;
    const failureCount = previous + 1;
    const errorCode: ConnectionHealthErrorCode = isConnectionHealthErrorCode(outcome.errorCode)
        ? outcome.errorCode
        : 'failed';

    if (CONNECTION_CREDENTIAL_ERROR_CODES.includes(errorCode)) {
        return { health: 'expired', errorCode, failureCount };
    }

    return {
        health: failureCount >= CONNECTION_UNREACHABLE_AFTER_FAILURES ? 'unreachable' : 'degraded',
        errorCode,
        failureCount,
    };
}
