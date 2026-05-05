/**
 * Kubernetes plugin errors and credential scrubber.
 *
 * Every error surfaced to the user MUST run through `scrubError` so a
 * forgotten log line in a future maintainer's PR cannot leak the kubeconfig
 * or registry password.
 */

export type K8sPluginErrorCode =
	| 'INVALID_YAML'
	| 'MISSING_CONTEXT'
	| 'MISSING_CLUSTER'
	| 'MISSING_USER'
	| 'CLUSTER_UNREACHABLE'
	| 'UNAUTHORIZED'
	| 'NOT_CONFIGURED'
	| 'GITHUB_NOT_CONNECTED'
	| 'REGISTRY_AUTH_FAILED'
	| 'APPLY_FAILED'
	| 'ROLLOUT_TIMEOUT'
	| 'UNKNOWN';

export class K8sPluginError extends Error {
	readonly code: K8sPluginErrorCode;
	readonly cause?: unknown;

	constructor(code: K8sPluginErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = 'K8sPluginError';
		this.code = code;
		this.cause = cause;
	}
}

/**
 * Result of running an arbitrary error through the credential scrubber.
 */
export interface ScrubbedError {
	code: K8sPluginErrorCode;
	message: string;
}

const REDACTED = '[REDACTED]';

/**
 * Patterns that MUST never appear in a user-visible message. Order matters
 * for some replacements (e.g. PEM blocks before generic password keys).
 */
const SCRUB_PATTERNS: ReadonlyArray<RegExp> = [
	// Full kubeconfig YAML (any `apiVersion: v1\nkind: Config`-shaped blob).
	/apiVersion:\s*v1[\s\S]+?kind:\s*Config[\s\S]+?(?=$|\n\S)/g,
	// PEM blocks (certs and keys).
	/-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g,
	// Authorization headers.
	/Authorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
	// `token: <something>` and `password: <something>` lines anywhere.
	/(\b(?:token|password|client-certificate-data|client-key-data|certificate-authority-data)\b\s*[:=]\s*)[^\s,;}"']+/gi,
];

export function scrubString(input: string, extraPatterns: RegExp[] = []): string {
	let out = input;
	for (const pattern of [...SCRUB_PATTERNS, ...extraPatterns]) {
		out = out.replace(pattern, (_match, prefix?: string) =>
			prefix ? `${prefix}${REDACTED}` : REDACTED,
		);
	}
	return out;
}

/**
 * Map an unknown thrown value to a safe `{ code, message }` for the UI.
 *
 * Pass `extraPatterns` to redact runtime-only secrets (e.g. the literal
 * registry password from current settings).
 */
export function scrubError(err: unknown, extraPatterns: RegExp[] = []): ScrubbedError {
	if (err instanceof K8sPluginError) {
		return { code: err.code, message: scrubString(err.message, extraPatterns) };
	}

	const rawMessage =
		err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';

	const message = scrubString(rawMessage, extraPatterns);
	const code = inferCodeFromMessage(message);
	return { code, message };
}

function inferCodeFromMessage(message: string): K8sPluginErrorCode {
	const lower = message.toLowerCase();
	if (lower.includes('enotfound') || lower.includes('econnrefused') || lower.includes('etimedout')) {
		return 'CLUSTER_UNREACHABLE';
	}
	if (lower.includes('certificate') && (lower.includes('expire') || lower.includes('invalid'))) {
		return 'CLUSTER_UNREACHABLE';
	}
	if (lower.includes('401') || lower.includes('403') || lower.includes('forbidden') || lower.includes('unauthorized')) {
		return 'UNAUTHORIZED';
	}
	return 'UNKNOWN';
}

/**
 * Build a literal-string scrub pattern for a runtime secret.
 * Escapes regex metachars so passwords containing `.`, `*`, etc. still scrub.
 */
export function buildSecretPattern(secret: string | undefined): RegExp | null {
	if (!secret || secret.length < 4) {
		return null;
	}
	const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(escaped, 'g');
}
