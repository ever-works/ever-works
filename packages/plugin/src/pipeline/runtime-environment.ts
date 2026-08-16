/**
 * Environments (Settings → Environments) — the plain, serializable shape of
 * a resolved runtime Environment as it travels from the platform (the
 * `environments` table row assigned to the run's Agent) into pipeline
 * plugins via `StepExecutionContext.runtimeEnvironment`.
 *
 * Deliberately a data-only mirror of the entity (no ids of other rows, no
 * Dates): pipeline plugins run behind an RPC boundary in some deployments,
 * so everything here must survive `JSON.stringify` round-trips unchanged.
 */

export type RuntimeEnvironmentNetworkingMode = 'unrestricted' | 'limited';

export interface RuntimeEnvironmentData {
	/** `environments.id` — carried for logging/attribution only. */
	readonly id: string;
	readonly name: string;
	readonly slug: string;
	/** Validated pip requirement specifiers (e.g. `requests`, `pandas==2.2.0`). */
	readonly pipPackages: readonly string[];
	/** Validated npm install targets (e.g. `typescript`, `@scope/pkg@^1.2.0`). */
	readonly npmPackages: readonly string[];
	readonly networkingMode: RuntimeEnvironmentNetworkingMode;
	/** Egress allow-list; only meaningful when `networkingMode === 'limited'`. */
	readonly allowedHosts: readonly string[] | null;
	readonly allowPackageManagers: boolean;
}

/**
 * Security note on all three regexes below: these names/specs are later
 * composed into package-manager install commands and into provider API
 * payloads, so the validators are strict ALLOW-lists. Every shell
 * metacharacter (whitespace, `;`, `|`, `&`, `$`, backticks, quotes,
 * parentheses, braces, redirects, backslash, `#`) is outside the allowed
 * alphabet, and the first character must be alphanumeric (or `@` for a
 * scoped npm name) so a spec can never be parsed as a CLI flag (`--…`).
 */

/** Total length cap for a single package spec. */
export const RUNTIME_ENVIRONMENT_PACKAGE_SPEC_MAX_LENGTH = 128;

/** How many packages a single Environment may declare per ecosystem. */
export const RUNTIME_ENVIRONMENT_MAX_PACKAGES = 100;

/** How many hosts a limited-networking Environment may allow. */
export const RUNTIME_ENVIRONMENT_MAX_ALLOWED_HOSTS = 200;

/**
 * PEP 508-ish requirement specifier subset: name, optional extras,
 * optional comma-separated version constraints. Examples that pass:
 * `requests`, `pandas==2.2.0`, `uvicorn[standard]>=0.29,<1`.
 *
 * Every comparison operator must be followed by a DIGIT (PEP 440
 * versions start numerically) so a spec like `requests>out.txt` — a
 * would-be shell redirect if a composed command were ever left
 * unquoted — cannot validate.
 */
const PIP_PACKAGE_SPEC_RE =
	/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?(?:(?:===|==|>=|<=|~=|!=|>|<)[0-9][A-Za-z0-9.*+!-]*(?:,(?:===|==|>=|<=|~=|!=|>|<)[0-9][A-Za-z0-9.*+!-]*)*)?$/;

/**
 * npm install target subset: optionally scoped name, optional version /
 * range / dist-tag suffix. Examples that pass: `typescript`,
 * `@types/node@^22`, `eslint@9.1.0`, `left-pad@latest`.
 *
 * The suffix after `@` is either a dist-tag / plain version (starts
 * alphanumeric) or range operators (`^~<>=`, at most two) followed by a
 * DIGIT — same anti-redirect rationale as the pip regex.
 */
const NPM_PACKAGE_SPEC_RE =
	/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@(?:[A-Za-z0-9][A-Za-z0-9.*+x-]*|[~^<>=]{1,2}[0-9][A-Za-z0-9.*+x.-]*))?$/;

/**
 * Hostname (RFC 1123 subset) with an optional single leading `*.`
 * wildcard label. No ports, no schemes, no paths.
 */
const ALLOWED_HOST_RE =
	/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

/**
 * An egress allow-list entry names a PUBLIC service the sandbox may
 * reach. IP literals and loopback/link-local names are rejected outright:
 * the hostname grammar above happily matches `localhost` and dotted-quad
 * literals like `169.254.169.254`, and allow-listing one of those would
 * authorize a limited Environment to reach services inside the runtime's
 * own network — cloud instance-metadata endpoints first among them.
 */
const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Bare `localhost` plus anything under a loopback/internal-only suffix. */
const LOCAL_HOST_NAME_RE = /(^|\.)(?:localhost|local|internal|localdomain)$/i;

function isIpLiteralHost(host: string): boolean {
	// IPv6 literals contain a colon, which the hostname grammar already
	// rejects; the explicit check keeps the intent readable and covers
	// bracketed forms should the grammar ever widen.
	return IPV4_LITERAL_RE.test(host) || host.includes(':') || host.startsWith('[');
}

export function isValidPipPackageSpec(spec: string): boolean {
	return (
		typeof spec === 'string' &&
		spec.length > 0 &&
		spec.length <= RUNTIME_ENVIRONMENT_PACKAGE_SPEC_MAX_LENGTH &&
		PIP_PACKAGE_SPEC_RE.test(spec)
	);
}

export function isValidNpmPackageSpec(spec: string): boolean {
	return (
		typeof spec === 'string' &&
		spec.length > 0 &&
		spec.length <= RUNTIME_ENVIRONMENT_PACKAGE_SPEC_MAX_LENGTH &&
		NPM_PACKAGE_SPEC_RE.test(spec)
	);
}

export function isValidAllowedHost(host: string): boolean {
	return (
		typeof host === 'string' &&
		host.length > 0 &&
		host.length <= 253 &&
		ALLOWED_HOST_RE.test(host) &&
		!isIpLiteralHost(host) &&
		!LOCAL_HOST_NAME_RE.test(host)
	);
}

export interface RuntimePackageListNormalization {
	/** Trimmed, deduplicated entries that passed validation, in input order. */
	readonly valid: string[];
	/** Trimmed entries that failed validation, in input order. */
	readonly invalid: string[];
}

/**
 * Trim / drop-empty / dedupe / validate a raw package list. Used by the
 * platform DTO layer AND re-applied inside consuming plugins (defense in
 * depth — the values end up in install commands).
 */
export function normalizeRuntimePackageList(
	values: readonly string[] | null | undefined,
	kind: 'pip' | 'npm'
): RuntimePackageListNormalization {
	const isValid = kind === 'pip' ? isValidPipPackageSpec : isValidNpmPackageSpec;
	const seen = new Set<string>();
	const valid: string[] = [];
	const invalid: string[] = [];

	for (const raw of values ?? []) {
		const trimmed = typeof raw === 'string' ? raw.trim() : '';
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		if (isValid(trimmed)) {
			valid.push(trimmed);
		} else {
			invalid.push(trimmed);
		}
	}

	return { valid, invalid };
}
