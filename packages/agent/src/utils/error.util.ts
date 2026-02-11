/**
 * Safely extracts error message from an unknown error value.
 * @param error The caught error (unknown type in strict mode)
 * @returns The error message string
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/**
 * Safely extracts error stack from an unknown error value.
 * @param error The caught error (unknown type in strict mode)
 * @returns The error stack string or undefined
 */
export function getErrorStack(error: unknown): string | undefined {
    if (error instanceof Error) {
        return error.stack;
    }
    return undefined;
}
