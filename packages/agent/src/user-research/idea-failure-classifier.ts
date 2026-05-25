import { IdeaFailureKind } from '../entities/work-proposal.entity';

/**
 * Phase 1 PR FF — built-in transient-error classifier for the
 * Goal-completion auto-retry decision (spec §3.9, Decision A23).
 *
 * Per Decision A23 the classifier is **platform-managed code**, not
 * user-configurable. Adding a new classifiable error class means
 * extending this file (and `IdeaFailureKind`), not a settings UI.
 * Implementers MUST NOT add a "configure which errors to retry"
 * pref without a separate spec — see PLAN §16 "what plan does NOT
 * do" entry (v6).
 *
 * The classifier inspects an arbitrary error value (string, Error,
 * unknown) and returns one of `IdeaFailureKind` values. Transient
 * kinds (`TRANSIENT_*`) are eligible for the auto-retry loop in
 * `handleGoalCompletion`; permanent kinds (`PERMANENT_*`) skip
 * auto-retry — the user can still manually click Retry.
 *
 * Heuristics ordered by specificity:
 *   1. HTTP status code if present on a fetch-Error-style object
 *      (`err.status` or `err.statusCode`).
 *   2. String-pattern matches on the error message — these catch
 *      generic Node / undici / axios errors that don't carry a
 *      structured status.
 *   3. Fallback: `PERMANENT_UNKNOWN`.
 *
 * Add new patterns BELOW the existing ones (LIFO precedence is fine
 * — the regex `test()` is short-circuit), but keep transient
 * patterns above permanent patterns so a generic transient signal
 * isn't shadowed by a more specific permanent one.
 *
 * Pure function — no I/O, no logging, no side effects. Safe to
 * call repeatedly. Unit-tested in `__tests__/idea-failure-classifier.spec.ts`.
 */
export function classifyIdeaFailure(input: unknown): IdeaFailureKind {
    // ── (1) Structured HTTP status, when the error object carries one.
    const status = extractStatusCode(input);
    if (status !== null) {
        if (status === 429) return IdeaFailureKind.TRANSIENT_RATE_LIMIT;
        if (status >= 500 && status < 600) return IdeaFailureKind.TRANSIENT_UPSTREAM_5XX;
        // 4xx (other than 429) → invalid input from the user-side or
        // upstream contract drift; both are non-retryable without
        // human investigation.
        if (status >= 400 && status < 500) return IdeaFailureKind.PERMANENT_INVALID_INPUT;
    }

    // ── (2) Message-pattern matches.
    const message = extractMessage(input).toLowerCase();
    if (!message) {
        return IdeaFailureKind.PERMANENT_UNKNOWN;
    }

    // Transient — network layer.
    if (
        /econn(refused|reset|aborted)/i.test(message) ||
        /etimedout|esockettimedout/i.test(message) ||
        /enotfound|eai_again|edns/i.test(message) ||
        /network (error|request failed)/i.test(message) ||
        /socket hang up/i.test(message) ||
        /fetch failed/i.test(message)
    ) {
        return IdeaFailureKind.TRANSIENT_NETWORK;
    }

    // Transient — explicit rate-limit phrasing without a structured
    // status (e.g. provider SDKs that throw with prose).
    if (
        /rate.?limit/i.test(message) ||
        /too many requests/i.test(message) ||
        /quota exceeded/i.test(message) ||
        /throttl/i.test(message)
    ) {
        return IdeaFailureKind.TRANSIENT_RATE_LIMIT;
    }

    // Transient — explicit upstream 5xx phrasing without status.
    if (
        /5\d\d/.test(message) ||
        /upstream (error|unavailable)/i.test(message) ||
        /(bad )?gateway/i.test(message) ||
        /service unavailable/i.test(message) ||
        /internal server error/i.test(message)
    ) {
        return IdeaFailureKind.TRANSIENT_UPSTREAM_5XX;
    }

    // Transient — plugin-internal hiccup (LangChain timeouts, AI SDK
    // partial-stream errors, etc.).
    if (
        /timeout/i.test(message) ||
        /aborted/i.test(message) ||
        /stream (closed|interrupted|incomplete)/i.test(message) ||
        /langchain.*(retry|transient)/i.test(message) ||
        /provider (busy|overloaded)/i.test(message)
    ) {
        return IdeaFailureKind.TRANSIENT_PLUGIN;
    }

    // Permanent — explicit "invalid input / validation" phrasing.
    if (
        /invalid (input|request|argument|format)/i.test(message) ||
        /validation (error|failed)/i.test(message) ||
        /malformed/i.test(message) ||
        /schema (error|mismatch)/i.test(message)
    ) {
        return IdeaFailureKind.PERMANENT_INVALID_INPUT;
    }

    return IdeaFailureKind.PERMANENT_UNKNOWN;
}

/** True iff the classification is one of the auto-retryable kinds. */
export function isTransient(kind: IdeaFailureKind): boolean {
    return (
        kind === IdeaFailureKind.TRANSIENT_NETWORK ||
        kind === IdeaFailureKind.TRANSIENT_RATE_LIMIT ||
        kind === IdeaFailureKind.TRANSIENT_UPSTREAM_5XX ||
        kind === IdeaFailureKind.TRANSIENT_PLUGIN
    );
}

/**
 * Compute the wait between attempt N and attempt N+1 per the
 * exponential backoff policy on `WorkAgentPreference`. Spec §3.9 /
 * Decision A23:
 *
 *   wait = backoffSeconds * (factor ** attempts)
 *
 * `attempts` is the count of attempts already made — so the wait
 * before the first retry (attempts=1) is `backoffSeconds * factor`,
 * not `backoffSeconds` itself. (Spec example: defaults 60 + 2.0 →
 * 60s, 120s, 240s for the 1st/2nd/3rd retries.)
 *
 * Defensive bounds: `attempts < 0` clamps to 0, the result is
 * clamped to `[backoffSeconds, 24 * 3600]` (one day max) so a
 * misconfigured factor can't accidentally schedule a wait years
 * out.
 */
export function computeBackoffSeconds(
    backoffSeconds: number,
    factor: number,
    attempts: number,
): number {
    const safeAttempts = Math.max(0, Math.trunc(attempts));
    const safeBackoff = Math.max(1, backoffSeconds);
    const safeFactor = Math.max(1, factor);
    const raw = safeBackoff * Math.pow(safeFactor, safeAttempts);
    const oneDay = 24 * 3600;
    return Math.min(oneDay, Math.max(safeBackoff, Math.trunc(raw)));
}

// ─── internals ─────────────────────────────────────────────────────

function extractStatusCode(input: unknown): number | null {
    if (input === null || typeof input !== 'object') return null;
    const obj = input as Record<string, unknown>;
    for (const key of ['status', 'statusCode', 'code'] as const) {
        const v = obj[key];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 100 && v < 700) {
            return v;
        }
    }
    // Some SDKs nest the status under `response.status`.
    const resp = obj.response;
    if (resp && typeof resp === 'object') {
        const nested = (resp as Record<string, unknown>).status;
        if (typeof nested === 'number' && Number.isFinite(nested)) {
            return nested;
        }
    }
    return null;
}

function extractMessage(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input instanceof Error) return input.message ?? '';
    if (input && typeof input === 'object') {
        const m = (input as Record<string, unknown>).message;
        if (typeof m === 'string') return m;
    }
    return String(input ?? '');
}
