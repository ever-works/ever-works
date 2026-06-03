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

// Security: map HTTP status codes to safe fixed-string descriptions so that
// internal hostnames, IP addresses, or service names embedded in error strings
// from external (or SSRF-triggered internal) HTTP calls are never surfaced to users.
const HTTP_STATUS_DESCRIPTIONS: Record<string, string> = {
	'400': 'Bad Request',
	'401': 'Unauthorized',
	'402': 'Payment Required',
	'403': 'Forbidden',
	'404': 'Not Found',
	'405': 'Method Not Allowed',
	'406': 'Not Acceptable',
	'408': 'Request Timeout',
	'409': 'Conflict',
	'410': 'Gone',
	'413': 'Payload Too Large',
	'415': 'Unsupported Media Type',
	'422': 'Unprocessable Entity',
	'429': 'Too Many Requests',
	'500': 'Internal Server Error',
	'502': 'Bad Gateway',
	'503': 'Service Unavailable',
	'504': 'Gateway Timeout'
};

/** Returns a safe, fixed-string label for an HTTP status code. */
function httpStatusLabel(code: string): string {
	return HTTP_STATUS_DESCRIPTIONS[code] ?? 'HTTP Error';
}

/**
 * Converts a raw error message into a short, user-friendly reason string.
 *
 * - Zod / JSON-schema validation dumps → "the AI returned an unexpected response format"
 * - JSON parse errors                  → "the AI returned an invalid response"
 * - HTTP-style errors (401, 500, …)    → "HTTP <code> <fixed description>" (no hostnames/URLs)
 * - Everything else                    → kept but truncated to MAX_USER_REASON_LENGTH chars
 */
export function sanitizeErrorForUser(raw: string): string {
	if (ZOD_ARRAY_PATTERN.test(raw)) {
		return 'the AI returned an unexpected response format';
	}

	if (JSON_PARSE_PATTERN.test(raw)) {
		return 'the AI returned an invalid response';
	}

	// Security: HTTP errors are actionable but may embed internal hostnames or IPs.
	// Only surface the numeric status code with a fixed-string description; discard
	// the rest of the message to prevent information leakage about internal services.
	const httpMatch = HTTP_STATUS_PATTERN.exec(raw);
	if (httpMatch) {
		const code = httpMatch[1];
		return `HTTP ${code} ${httpStatusLabel(code)}`;
	}

	return raw.length > MAX_USER_REASON_LENGTH ? raw.slice(0, MAX_USER_REASON_LENGTH) + '…' : raw;
}
