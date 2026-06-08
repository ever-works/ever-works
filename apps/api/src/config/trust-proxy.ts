/**
 * EW-719: resolve how many reverse-proxy hops Express should trust when
 * deriving the client IP from `X-Forwarded-For`.
 *
 * The API runs behind an nginx ingress. Without `app.set('trust proxy', n)`
 * Express reports the ingress socket address as `req.ip` for every request and
 * leaves `req.ips` empty, so the per-IP rate limiter (`UserAwareThrottlerGuard`
 * → `getTracker`) collapses every anonymous client into ONE pod-wide bucket.
 * Setting the hop count makes Express skip the trailing `n` proxy addresses in
 * `X-Forwarded-For` and expose the real client IP as `req.ip`, restoring
 * per-client throttling.
 *
 * The hop count is operator-supplied (`TRUST_PROXY_HOPS`), so it must be
 * sanitised: a numeric value is honoured; anything missing or malformed falls
 * back to the documented default of one hop (the standard single nginx → pod
 * topology); negative values clamp to 0 (trust nobody — the safe, fail-closed
 * floor that keeps Express reading the direct socket IP rather than blindly
 * trusting a spoofable header).
 */

/** Documented default: a single nginx → pod hop. */
export const DEFAULT_TRUST_PROXY_HOPS = 1;

/**
 * Resolve the number of proxy hops to trust from the environment.
 *
 * - numeric `TRUST_PROXY_HOPS` (e.g. "2")  → that integer value
 * - missing / empty / non-numeric ("foo")  → {@link DEFAULT_TRUST_PROXY_HOPS}
 * - negative ("-3")                          → clamped to 0 (trust nobody)
 *
 * Fractional values are floored to the nearest integer (Express expects an
 * integer hop count). The return is always a finite, non-negative integer.
 */
export function resolveTrustProxyHops(
    env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
    const raw = env.TRUST_PROXY_HOPS;

    // Missing or blank → documented default.
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_TRUST_PROXY_HOPS;
    }

    // Strictly an integer (optionally signed). Reject anything else
    // ("foo", "2hops", "1.5", "") so a typo can't silently widen trust.
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
        return DEFAULT_TRUST_PROXY_HOPS;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_TRUST_PROXY_HOPS;
    }

    // Clamp negatives to 0 — fail closed (trust no proxy) rather than letting a
    // bad value disable the limit by trusting the spoofable header chain.
    return parsed < 0 ? 0 : parsed;
}
