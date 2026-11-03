/**
 * How the Ever ID handlers read a failed call to Ever Platform. The SDK throws
 * typed errors; they are told apart by `name` so a second copy of the SDK (its
 * CommonJS and ES builds) is read the same way.
 *
 * - `problem`: Ever Platform answered with a problem document (status + code).
 * - `refused`: the SDK refused to send the request (a body outside the pinned
 *   contract); sending it again changes nothing.
 * - `rate_limited`: held back or answered `429`; retry after `retryAfterS`.
 * - `transient`: no answer (network, timeout, an unreadable answer); retry.
 */
export type PlatformFailure =
    | { readonly kind: 'problem'; readonly status: number; readonly code: string }
    | { readonly kind: 'refused'; readonly code: string }
    | { readonly kind: 'rate_limited'; readonly retryAfterS: number }
    | { readonly kind: 'transient'; readonly code: string };

interface ErrorShape {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    retryAfterS?: unknown;
}

export function platformFailure(error: unknown): PlatformFailure {
    const e = (error && typeof error === 'object' ? error : {}) as ErrorShape;
    const code = typeof e.code === 'string' ? e.code : 'unknown';
    switch (e.name) {
        case 'ProblemError': {
            const status = typeof e.status === 'number' ? e.status : 0;
            if (status === 429) {
                return { kind: 'rate_limited', retryAfterS: retryAfter(e.retryAfterS) };
            }
            return { kind: 'problem', status, code };
        }
        case 'RateLimitedError':
            return { kind: 'rate_limited', retryAfterS: retryAfter(e.retryAfterS) };
        case 'RequestRefusedError':
        case 'EgressRefusedError':
            return { kind: 'refused', code };
        case 'TimeoutError':
            return { kind: 'transient', code: 'timeout' };
        default:
            return { kind: 'transient', code: typeof e.name === 'string' ? e.name : 'unknown' };
    }
}

function retryAfter(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 60;
}

/** A short, value-free description of a failure for a log line. */
export function describeFailure(failure: PlatformFailure): string {
    switch (failure.kind) {
        case 'problem':
            return `${failure.status} ${failure.code}`;
        case 'rate_limited':
            return `rate limited (${failure.retryAfterS} s)`;
        default:
            return `${failure.kind} ${failure.code}`;
    }
}
