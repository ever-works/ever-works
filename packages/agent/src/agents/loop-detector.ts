/**
 * Judgment layer G10 — the doom-loop / retry-storm detector.
 *
 * ## The failure this exists for
 *
 * A bounded retry budget stops a run from looping FOREVER. It does not
 * stop it from looping POINTLESSLY: an agent that fails `lint` with the
 * same error on attempt 1, attempt 2 and attempt 3 will happily spend
 * attempts 4 and 5 — and the tokens, the minutes and the credits behind
 * them — hitting the same wall. The attempt cap eventually ends it, and
 * the human learns nothing except that the budget is gone.
 *
 * This module is the cheap, deterministic answer: recognise "cycling
 * without progress" from the failure trail itself, stop, and escalate
 * with the evidence attached. The budget is then spent on a human
 * decision rather than on a fifth identical failure.
 *
 * ## Why it is a pure function
 *
 * The signal lives in the WORKER (inside the gate iterate loop, where the
 * attempt outcomes are), the escalation is written by the API, and the
 * tests need to drive a hundred synthetic trails in milliseconds. A pure
 * function over a plain sample array is the only shape that serves all
 * three without a service, a database, or a fake clock.
 *
 * ## What counts as a loop (and, more importantly, what does not)
 *
 * Two independent signals, both deliberately conservative — a detector
 * that fires on HEALTHY retries is worse than no detector at all,
 * because the first false positive teaches operators to switch it off:
 *
 *  - `repeated-failure` — the last `repeatThreshold` attempts produced
 *    ONE identical, non-empty failure fingerprint and none of them
 *    reported progress. Three identical failures in a row is not bad
 *    luck; it is the same wall.
 *  - `retry-storm` — the trail is at or past `maxRetries` attempts, no
 *    attempt reported progress, AND at least one failure repeated
 *    (`distinctFailures < attempts`). The last clause is what separates a
 *    storm from an agent legitimately marching through a list of
 *    different failures one at a time.
 *
 * A single attempt that reports progress (`progressed: true`) clears
 * BOTH signals for its window. Progress is the whole question; anything
 * that demonstrates it must reset the suspicion.
 */

/** One completed attempt of whatever is being retried. */
export interface LoopAttemptSample {
    /**
     * Stable identity of the failure this attempt produced, from
     * {@link fingerprintFailures}. An EMPTY string means "no failure
     * identity available" and can never contribute to a repeat run — an
     * unknown failure is not evidence of sameness.
     */
    fingerprint: string;
    /**
     * Did this attempt make measurable forward progress? Optional
     * because most callers only have the failure trail; supply it
     * whenever a real signal exists (fewer failing checks than last
     * time, new files changed, a check that went from red to green).
     */
    progressed?: boolean;
}

export interface DoomLoopOptions {
    /**
     * How many consecutive identical failures constitute a loop.
     * Clamped to `>= 2` — a threshold of 1 would fire on the very first
     * failure, which is a retry, not a loop.
     */
    repeatThreshold: number;
    /**
     * Attempt count at which a progress-free trail is called a storm.
     * Clamped to `>= 1`.
     */
    maxRetries: number;
}

export type DoomLoopSignal = 'repeated-failure' | 'retry-storm';

export interface DoomLoopVerdict {
    detected: boolean;
    /** Which rule fired. `null` when nothing did. */
    signal: DoomLoopSignal | null;
    /** Length of the trailing run of identical non-empty fingerprints. */
    repeats: number;
    /** Distinct non-empty fingerprints across the whole trail. */
    distinctFailures: number;
    /** Attempts considered (the sample count). */
    attempts: number;
    /** The repeating fingerprint, when `repeated-failure` fired. */
    fingerprint: string | null;
    /** One plain-text sentence for the escalation summary. Never markup. */
    reason: string;
}

/** Absolute bounds so a misconfigured env var cannot disable or spam the detector. */
export const MIN_LOOP_REPEAT_THRESHOLD = 2;
export const MAX_LOOP_REPEAT_THRESHOLD = 10;
export const MIN_LOOP_MAX_RETRIES = 1;
export const MAX_LOOP_MAX_RETRIES = 20;

/** Longest fingerprint retained. Log tails are unbounded upstream. */
const MAX_FINGERPRINT_CHARS = 400;

/**
 * Reduce one failure line to a comparison key that survives the noise a
 * re-run always changes.
 *
 * Timestamps, durations, byte counts, hex ids, uuids, absolute paths,
 * ports and line/column numbers all differ between two runs of the SAME
 * broken command. Comparing raw text would therefore report "different
 * failure" every time and the detector would never fire — which is the
 * failure mode this normalization exists to prevent.
 *
 * Deliberately aggressive: over-normalizing risks calling two different
 * failures the same, but the detector only ESCALATES (it never deletes
 * work, never fails a run on its own account), so the cost of a merge is
 * a human reading one card, while the cost of never merging is the loop
 * this module exists to stop.
 */
export function normalizeFailureText(value: string): string {
    return (
        String(value ?? '')
            .toLowerCase()
            // uuids first — they would otherwise be shredded by the hex rule.
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
            // ISO-ish timestamps.
            .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, '<ts>')
            // Windows + POSIX absolute paths (keep the basename, drop the tree).
            .replace(/[a-z]:\\[^\s:]+/g, '<path>')
            .replace(/(?:^|\s)\/[^\s:]+/g, ' <path>')
            // Long hex blobs (sha, run ids, addresses).
            .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
            // Any remaining number: durations, ports, line:col, byte counts.
            .replace(/\d+/g, '<n>')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_FINGERPRINT_CHARS)
    );
}

/**
 * Build one comparison key from the failures observed in an attempt.
 *
 * Order-insensitive by construction (the entries are sorted), because
 * "lint, typecheck" and "typecheck, lint" are the same failure state and
 * a runner is free to report them in either order.
 *
 * Returns `''` for an empty/absent trail — see {@link LoopAttemptSample}.
 */
export function fingerprintFailures(
    failures: ReadonlyArray<{ id?: unknown; outcome?: unknown } | null | undefined>,
): string {
    if (!Array.isArray(failures) || failures.length === 0) return '';
    const parts = failures
        .filter((failure): failure is { id?: unknown; outcome?: unknown } => Boolean(failure))
        .map((failure) =>
            `${normalizeFailureText(String(failure.id ?? ''))}=${normalizeFailureText(
                String(failure.outcome ?? ''),
            )}`.trim(),
        )
        .filter((part) => part.length > 1)
        .sort();
    return parts.join('|').slice(0, MAX_FINGERPRINT_CHARS);
}

/** Clamp the operator-supplied thresholds into a sane, non-degenerate range. */
export function resolveLoopThresholds(options: Partial<DoomLoopOptions>): DoomLoopOptions {
    const repeat = Number(options.repeatThreshold);
    const retries = Number(options.maxRetries);
    return {
        repeatThreshold: Number.isFinite(repeat)
            ? Math.min(
                  MAX_LOOP_REPEAT_THRESHOLD,
                  Math.max(MIN_LOOP_REPEAT_THRESHOLD, Math.trunc(repeat)),
              )
            : MIN_LOOP_REPEAT_THRESHOLD + 1,
        maxRetries: Number.isFinite(retries)
            ? Math.min(MAX_LOOP_MAX_RETRIES, Math.max(MIN_LOOP_MAX_RETRIES, Math.trunc(retries)))
            : 4,
    };
}

/**
 * Decide whether an attempt trail is a doom loop.
 *
 * Never throws and never mutates its input: this runs on an error path
 * inside a worker, so a detector that could fail would take the run's
 * real failure down with it.
 */
export function detectDoomLoop(
    samples: readonly LoopAttemptSample[],
    options: Partial<DoomLoopOptions> = {},
): DoomLoopVerdict {
    const { repeatThreshold, maxRetries } = resolveLoopThresholds(options);
    const trail = Array.isArray(samples) ? samples.filter(Boolean) : [];
    const attempts = trail.length;

    const distinctFailures = new Set(
        trail.map((sample) => String(sample.fingerprint ?? '')).filter((fp) => fp.length > 0),
    ).size;

    // Trailing run of identical, non-empty fingerprints. Walked from the
    // END because only the RECENT past says anything about whether the
    // run is stuck now — a repeat that was broken by progress two
    // attempts ago is history, not a loop.
    let repeats = 0;
    let fingerprint: string | null = null;
    for (let index = trail.length - 1; index >= 0; index -= 1) {
        const sample = trail[index];
        const current = String(sample.fingerprint ?? '');
        if (!current) break;
        if (sample.progressed === true) break;
        if (fingerprint === null) {
            fingerprint = current;
            repeats = 1;
            continue;
        }
        if (current !== fingerprint) break;
        repeats += 1;
    }

    const base = {
        repeats,
        distinctFailures,
        attempts,
        fingerprint: repeats >= 2 ? fingerprint : null,
    };

    if (repeats >= repeatThreshold) {
        return {
            ...base,
            detected: true,
            signal: 'repeated-failure',
            reason:
                `The same failure repeated ${repeats} times in a row with no progress ` +
                `(threshold ${repeatThreshold}).`,
        };
    }

    const anyProgress = trail.some((sample) => sample.progressed === true);
    if (attempts >= maxRetries && !anyProgress && distinctFailures < attempts) {
        return {
            ...base,
            detected: true,
            signal: 'retry-storm',
            reason:
                `${attempts} attempts made no progress and only produced ${distinctFailures} ` +
                `distinct failure(s) (retry ceiling ${maxRetries}).`,
        };
    }

    return {
        ...base,
        detected: false,
        signal: null,
        reason:
            attempts === 0
                ? 'No attempts recorded.'
                : `${attempts} attempt(s), ${distinctFailures} distinct failure(s), ` +
                  `longest identical run ${repeats}.`,
    };
}
