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
	| 'KUBECONFIG_UNSUPPORTED'
	| 'CLUSTER_ADDRESS_NOT_PUBLIC'
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
 *
 * Full kubeconfig blobs and PEM blocks come first, and are found by the
 * scanners below ({@link findKubeconfigBlob}, {@link findPemBlock}) rather than
 * by a regex — see there for why.
 */
const SCRUB_PATTERNS: ReadonlyArray<RegExp> = [
	// Authorization headers.
	/Authorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
	// `token: <something>` and `password: <something>` lines anywhere.
	/(\b(?:token|password|client-certificate-data|client-key-data|certificate-authority-data)\b\s*[:=]\s*)[^\s,;}"']+/gi
];

/** A half-open `[start, end)` range of a text. */
type Span = readonly [start: number, end: number];

/**
 * Replace every span `find` reports with `[REDACTED]`, left to right, the way a
 * global `String.replace` would: each search resumes where the last span ended.
 */
function redactSpans(text: string, find: (text: string, from: number) => Span | null): string {
	let out = '';
	let from = 0;
	for (let span = find(text, 0); span !== null; span = find(text, from)) {
		out += text.slice(from, span[0]) + REDACTED;
		from = span[1];
	}
	return out + text.slice(from);
}

/** JavaScript's `\s`, for one character. */
function isRegexSpace(char: string | undefined): boolean {
	return char !== undefined && /\s/.test(char);
}

function skipSpaces(text: string, at: number): number {
	let index = at;
	while (isRegexSpace(text[index])) index += 1;
	return index;
}

/**
 * A full kubeconfig YAML blob: `apiVersion:␣*v1`, at least one character, the
 * first `kind:␣*Config` after it, at least one character, and then up to — not
 * including — the first newline followed by a non-space character, or the end
 * of the text. This is, span for span, what
 * `/apiVersion:\s*v1[\s\S]+?kind:\s*Config[\s\S]+?(?=$|\n\S)/g` matched.
 *
 * ## Why a scanner and not that regex (CodeQL js/polynomial-redos)
 *
 * The regex's lazy `[\s\S]+?` scans to the end of the text for every opener
 * that has no `kind: Config` after it, so a message holding many openers cost
 * quadratic time — 50 000 of them took ~4 s. The messages scrubbed here carry
 * what the tenant's own cluster answered and what its kubeconfig held, so that
 * is input a tenant writes. The scanner stops at the first opener with no
 * `kind: Config` after it: any later opener has even less text after it.
 */
function findKubeconfigBlob(text: string, from: number): Span | null {
	for (let at = text.indexOf('apiVersion:', from); at !== -1; at = text.indexOf('apiVersion:', at + 1)) {
		const version = skipSpaces(text, at + 'apiVersion:'.length);
		if (!text.startsWith('v1', version)) continue;
		const configEnd = kindConfigEnd(text, version + 'v1'.length + 1);
		// No `kind: Config` after this opener (or nothing after it) means none
		// for any later opener either.
		if (configEnd === -1 || configEnd >= text.length) return null;
		return [at, blobEnd(text, configEnd + 1)];
	}
	return null;
}

/** The index just past the first `kind:␣*Config` at or after `from`, or -1. */
function kindConfigEnd(text: string, from: number): number {
	for (let at = text.indexOf('kind:', from); at !== -1; at = text.indexOf('kind:', at + 1)) {
		const value = skipSpaces(text, at + 'kind:'.length);
		if (text.startsWith('Config', value)) return value + 'Config'.length;
	}
	return -1;
}

/** The first index at or after `from` that is a newline followed by a non-space, or the end of the text. */
function blobEnd(text: string, from: number): number {
	for (let newline = text.indexOf('\n', from); newline !== -1; newline = text.indexOf('\n', newline + 1)) {
		if (newline + 1 < text.length && !isRegexSpace(text[newline + 1])) return newline;
	}
	return text.length;
}

/**
 * A PEM block: `-----BEGIN <label>-----`, at least one character, then the
 * first `-----END <label>-----` (each label one or more non-`-` characters).
 * Span for span what `/-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g`
 * matched, without its quadratic rescan when many headers have no END line
 * after them (50 000 took ~30 s) — see {@link findKubeconfigBlob}.
 */
function findPemBlock(text: string, from: number): Span | null {
	for (let at = text.indexOf('-----BEGIN ', from); at !== -1; at = text.indexOf('-----BEGIN ', at + 1)) {
		const headerEnd = pemMarkerEnd(text, at, '-----BEGIN ');
		if (headerEnd === -1) continue;
		for (let end = text.indexOf('-----END ', headerEnd + 1); end !== -1; end = text.indexOf('-----END ', end + 1)) {
			const footerEnd = pemMarkerEnd(text, end, '-----END ');
			if (footerEnd !== -1) return [at, footerEnd];
		}
		// No END line after this header means none for any later header either.
		return null;
	}
	return null;
}

/** The index just past `<marker><one or more non-dashes>-----` at `at`, or -1. */
function pemMarkerEnd(text: string, at: number, marker: string): number {
	const labelStart = at + marker.length;
	let labelEnd = labelStart;
	while (labelEnd < text.length && text[labelEnd] !== '-') labelEnd += 1;
	if (labelEnd === labelStart || !text.startsWith('-----', labelEnd)) return -1;
	return labelEnd + '-----'.length;
}

/**
 * Replace every match of every pattern with `[REDACTED]`, keeping the prefix of
 * the patterns that capture one (`token: hunter2` → `token: [REDACTED]`).
 * Kubeconfig blobs and PEM blocks go first, in that order.
 *
 * ## Why the replacer checks the TYPE of its second argument
 *
 * A `String.replace` callback receives the capture groups after the match — and
 * when the pattern has NO group, the argument in that position is the match
 * **offset**, a number. Two of the patterns here are deliberately group-less:
 * the `Authorization: Bearer …` pattern (there is no prefix worth keeping) and
 * `buildSecretPattern`, which matches a runtime secret literally.
 *
 * Reading that argument as a group therefore spliced the offset into the
 * message whenever the secret was not at index 0 — a registry failure read
 * `401 Unauthorized for 37[REDACTED]`. It went unnoticed because `0` is falsy,
 * so the "the whole line is the secret" case was correct, and because every
 * assertion was `not.toContain(secret)`, which holds either way. The spec now
 * asserts these redactions by equality.
 */
export function scrubString(input: string, extraPatterns: RegExp[] = []): string {
	let out = redactSpans(redactSpans(input, findKubeconfigBlob), findPemBlock);
	for (const pattern of [...SCRUB_PATTERNS, ...extraPatterns]) {
		out = out.replace(pattern, (_match: string, ...groups: unknown[]) => {
			const prefix = typeof groups[0] === 'string' ? groups[0] : '';
			return prefix ? `${prefix}${REDACTED}` : REDACTED;
		});
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

	const rawMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';

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
	if (
		lower.includes('401') ||
		lower.includes('403') ||
		lower.includes('forbidden') ||
		lower.includes('unauthorized')
	) {
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
