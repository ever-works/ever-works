import { GENERATION_CANCELLED } from '../constants';

export function createGenerationCancelledError(): Error {
    const error = new Error(GENERATION_CANCELLED);
    error.name = 'AbortError';
    return error;
}

export function isGenerationCancelledError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    return (
        error.name === 'AbortError' ||
        error.message.toLowerCase() === GENERATION_CANCELLED.toLowerCase()
    );
}

export function throwIfGenerationCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        if (signal.reason instanceof Error) {
            throw signal.reason;
        }

        throw createGenerationCancelledError();
    }
}
