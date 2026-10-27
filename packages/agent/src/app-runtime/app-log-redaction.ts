/**
 * Lane aw-ops (APW-06 FR-48, 2026-10-27) — the API-side redaction pass over a log tail.
 *
 * FR-48: "every secret env value of 8 or more characters replaced by its name". The isolated
 * worker's `getAppLogs` already redacts with the `secretValues` its request carries, but the API
 * must never put a secret value into an `app-cluster-op` payload (a job runtime stores payloads),
 * so the worker's pass sees none. The API holds the env key, so it redacts the cached tail again
 * at read time, with the values {@link AppEnvRuntimeSource.secretValuesForRedaction} reads, before
 * a single line leaves it. A tail cached by a worker of any version is redacted the same way.
 *
 * Pure: no I/O, no logging. Matching is literal (no regular expressions are built from a value),
 * longest value first, so a value that contains a shorter one is replaced whole.
 */

import type { AppLogTail } from '@ever-works/plugin';

/** FR-48 — shorter values are left alone (they would match ordinary words). */
export const APP_LOG_REDACT_MIN_CHARS = 8;

/** One container's lines, as the tail carries them. */
type TailContainer = AppLogTail['containers'][number];

/**
 * Replace every value of `secretValues` that is at least {@link APP_LOG_REDACT_MIN_CHARS} long by
 * its name, in every line of every container. `redactedNames` becomes the union of the tail's own
 * list and every name that has a value long enough to be redacted (sorted, no duplicates), so the
 * reader can say which names were hidden without knowing whether one actually occurred.
 */
export function redactAppLogTail(
    tail: AppLogTail | null | undefined,
    secretValues: Record<string, string> | null | undefined,
): AppLogTail | null {
    if (!tail || !Array.isArray(tail.containers)) return null;

    const entries = Object.entries(secretValues ?? {})
        .filter(
            ([name, value]) =>
                typeof name === 'string' &&
                name.length > 0 &&
                typeof value === 'string' &&
                value.length >= APP_LOG_REDACT_MIN_CHARS,
        )
        .sort(([leftName, leftValue], [rightName, rightValue]) =>
            rightValue.length !== leftValue.length
                ? rightValue.length - leftValue.length
                : leftName.localeCompare(rightName),
        );

    const containers: TailContainer[] = tail.containers.map((container) => ({
        pod: String(container?.pod ?? ''),
        container: String(container?.container ?? ''),
        truncated: container?.truncated === true,
        lines: (Array.isArray(container?.lines) ? container.lines : []).map((line) =>
            redactLine(String(line ?? ''), entries),
        ),
    }));

    const names = new Set<string>(
        (Array.isArray(tail.redactedNames) ? tail.redactedNames : []).map(String),
    );
    for (const [name] of entries) names.add(name);

    return {
        containers,
        redactedNames: [...names].sort(),
        fetchedAt: String(tail.fetchedAt ?? ''),
    };
}

function redactLine(line: string, entries: ReadonlyArray<[string, string]>): string {
    let out = line;
    for (const [name, value] of entries) {
        if (out.includes(value)) out = out.split(value).join(name);
    }
    return out;
}
