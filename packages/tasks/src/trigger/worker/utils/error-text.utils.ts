/**
 * The two renderings of a caught value that the App runtime tasks and their local worker use.
 *
 * - {@link errorText} is for **answers**: a task's result (which Trigger.dev stores as the run's
 *   output and which `app-runtime:local-worker` hands back over HTTP from `POST /run`), a
 *   `work_deployments.lastError` row the Deploy tab shows, and any other value that leaves the
 *   process. It is an `Error`'s `message` — never its `stack` — and, for any other thrown value,
 *   only what kind of value it was. A thrown non-`Error` is not stringified into an answer: its
 *   `String()` is whatever the thrower made it (a stack pasted into a string, an object with a
 *   custom `toString`).
 * - {@link logText} is for **logs** — the run's `logger` or the worker's own stderr: the full text,
 *   stack included, so an operator still has everything the answer leaves out.
 *
 * One helper, imported by every file that renders a failure into a result, so a task's result and
 * the local worker's answer cannot follow different rules.
 */

/** The text an answer may carry for a failure. See the module comment. */
export function errorText(error: unknown): string {
    return error instanceof Error
        ? error.message
        : `a non-Error value (${typeof error}) was thrown — its text is in the log, not in this answer`;
}

/** The full text for a log line: the stack when there is one, `String()` otherwise. Never throws. */
export function logText(error: unknown): string {
    if (error instanceof Error) return error.stack ?? error.message;
    try {
        return String(error);
    } catch {
        return `a non-Error value (${typeof error}) that cannot be stringified`;
    }
}
