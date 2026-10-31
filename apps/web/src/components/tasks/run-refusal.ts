import type { RunTaskResult } from '@/lib/api/tasks';

/**
 * APW-08 T12 (ACC-08-08) — a dispatch the platform REFUSED is answered 2xx, not as an error: the
 * Task exists and the request was valid, but no run row was written and nothing started
 * (`dispatched: false`, `parked: false`), with the reason as `code: sentence` — no isolated
 * runtime for an App Work (S15), an Agent that may not commit (FR-9), App changes paused with no
 * row to park in (T49). It must never read as "Run started", nor count as started.
 */
export function isRunRefused(run: Pick<RunTaskResult, 'dispatched' | 'parked'>): boolean {
    return !run.dispatched && !run.parked;
}

const REFUSAL_PATTERN = /^[A-Za-z][\w-]*:\s+([\s\S]+)$/;

/** The refusal's own sentence (the stable `code: ` prefix dropped), or a plain fallback. */
export function runRefusalText(error: string | null | undefined): string {
    const match = REFUSAL_PATTERN.exec((error ?? '').trim());
    return match ? match[1].trim() : 'The run did not start.';
}
