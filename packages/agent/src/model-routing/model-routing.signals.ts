/**
 * Model accounts (AW-16) — reading a provider error for the one signal the
 * account layer acts on today: "the provider refused this credential".
 *
 * Pure, no I/O. Deliberately narrow: an HTTP 401 or 403 carried on the error
 * (as `status`, `statusCode`, `response.status` or `cause.status`) is a
 * rejection; nothing else is. A network failure, a rate limit or a malformed
 * request is not evidence the credential is bad, and treating it as one would
 * mark working accounts invalid.
 */
export function isCredentialRejection(error: unknown): boolean {
    const status = statusOf(error);
    return status === 401 || status === 403;
}

function statusOf(error: unknown, depth = 0): number | null {
    if (!error || typeof error !== 'object' || depth > 3) return null;
    const candidate = error as {
        status?: unknown;
        statusCode?: unknown;
        response?: { status?: unknown };
        cause?: unknown;
    };
    for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
    }
    return statusOf(candidate.cause, depth + 1);
}
