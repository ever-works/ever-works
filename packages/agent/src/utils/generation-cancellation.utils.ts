import { GENERATION_CANCELLED } from '../constants';

/**
 * Builds the canonical "generation cancelled" error used across the agent
 * package. Naming it `AbortError` lets callers compare against the standard
 * DOM AbortSignal convention without importing this module.
 */
export function createGenerationCancelledError(): Error {
    const error = new Error(GENERATION_CANCELLED);
    error.name = 'AbortError';
    return error;
}

/**
 * Returns `true` when the given value is an `Error` that represents a
 * cancelled generation. Matches either the `AbortError` name or the
 * `GENERATION_CANCELLED` message (case-insensitive) so it stays robust
 * against errors that travelled through `JSON.stringify`/`new Error(msg)`
 * round-trips and lost their original `name`.
 */
export function isGenerationCancelledError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    return (
        error.name === 'AbortError' ||
        error.message.toLowerCase() === GENERATION_CANCELLED.toLowerCase()
    );
}

/**
 * Throws when `signal` has already been aborted. Re-throws the signal's
 * `reason` if it was supplied as an `Error` (preserving stack traces from
 * the original aborter), otherwise raises a fresh cancellation error.
 * Safe to pass `undefined` — used as a lightweight guard inside long-running
 * generation steps that may have been started without a cancellation source.
 */
export function throwIfGenerationCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        if (signal.reason instanceof Error) {
            throw signal.reason;
        }

        throw createGenerationCancelledError();
    }
}
