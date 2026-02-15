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

const HTTP_STATUS_PATTERN = /\b(\d{3})[\s:]/;
const ZOD_ARRAY_PATTERN = /^\s*\[.*"code"\s*:\s*"[^"]+"/s;
const JSON_PARSE_PATTERN = /unexpected\s+(character|token|end)/i;
const MAX_USER_REASON_LENGTH = 120;

/**
 * Converts a raw error message into a short, user-friendly reason string.
 *
 * - Zod / JSON-schema validation dumps → "the AI returned an unexpected response format"
 * - JSON parse errors                  → "the AI returned an invalid response"
 * - HTTP-style errors (401, 500, …)    → kept as-is (actionable for the user)
 * - Everything else                    → kept but truncated to MAX_USER_REASON_LENGTH chars
 */
export function sanitizeErrorForUser(raw: string): string {
	if (ZOD_ARRAY_PATTERN.test(raw)) {
		return 'the AI returned an unexpected response format';
	}

	if (JSON_PARSE_PATTERN.test(raw)) {
		return 'the AI returned an invalid response';
	}

	// HTTP errors are actionable — keep them but cap length
	if (HTTP_STATUS_PATTERN.test(raw)) {
		return raw.length > MAX_USER_REASON_LENGTH ? raw.slice(0, MAX_USER_REASON_LENGTH) + '…' : raw;
	}

	return raw.length > MAX_USER_REASON_LENGTH ? raw.slice(0, MAX_USER_REASON_LENGTH) + '…' : raw;
}
