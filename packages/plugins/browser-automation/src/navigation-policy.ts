import { isIP } from 'node:net';
import * as dns from 'node:dns';
import type {
	BrowserBlockReason,
	BrowserNavigationPolicy,
	BrowserSessionSpec,
	PluginSettings
} from '@ever-works/plugin';
import { BrowserNavigationBlockedError } from '@ever-works/plugin';
import {
	isPrivateIPv4,
	isPrivateIPv6,
	isSafeWebhookUrl,
	type DnsResolver
} from '@ever-works/plugin/helpers/ssrf-guard';

/** Wall-clock budget applied to navigation and to each action. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;

/** Upper bound on nodes returned by one `extract` call. */
export const MAX_EXTRACT_NODES = 500;
/** Upper bound on steps accepted by one `act` call. */
export const MAX_ACT_STEPS = 50;

/**
 * The bare `*` pattern — "any PUBLIC host". Private / loopback /
 * link-local / cloud-metadata targets stay blocked underneath it, and it
 * is refused outright when `allowPrivateNetwork` is on (see
 * {@link resolveNavigationPolicy}).
 */
const WILDCARD_ALL = '*';

/** A parsed allowlist entry: host matcher plus an optional pinned port. */
export interface HostPattern {
	/** `*`, `*.example.com`, `example.com`, or a literal IP. */
	readonly host: string;
	/** Pinned port as a string, or null when any port is acceptable. */
	readonly port: string | null;
}

/**
 * Normalize a hostname for comparison: lowercase, brackets stripped off
 * IPv6 literals, and the FQDN trailing dot removed (`example.com.` and
 * `example.com` are the same host — treating them differently is a
 * classic allowlist bypass).
 */
export function normalizeHost(rawHost: string): string {
	let host = rawHost.trim().toLowerCase();
	if (host.startsWith('[') && host.endsWith(']')) {
		host = host.slice(1, -1);
	}
	while (host.endsWith('.')) {
		host = host.slice(0, -1);
	}
	return host;
}

/**
 * Parse one allowlist entry. Returns null for anything that is not a
 * bare host pattern — a scheme, a path, or an empty string is a
 * configuration mistake and must NEVER be interpreted loosely.
 */
export function parseHostPattern(raw: string): HostPattern | null {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return null;
	if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes('@') || trimmed.includes(' ')) {
		return null;
	}
	if (trimmed === WILDCARD_ALL) return { host: WILDCARD_ALL, port: null };

	let hostPart = trimmed;
	let port: string | null = null;

	if (hostPart.startsWith('[')) {
		// Bracketed IPv6 literal, optionally `]:port`.
		const close = hostPart.indexOf(']');
		if (close === -1) return null;
		const tail = hostPart.slice(close + 1);
		if (tail.startsWith(':')) {
			port = tail.slice(1);
			hostPart = hostPart.slice(0, close + 1);
		} else if (tail.length > 0) {
			return null;
		}
	} else {
		const colon = hostPart.lastIndexOf(':');
		// A colon that is not the port separator means an unbracketed IPv6
		// literal — ambiguous, so refuse rather than guess.
		if (colon !== -1) {
			const maybePort = hostPart.slice(colon + 1);
			if (!/^\d{1,5}$/.test(maybePort)) return null;
			port = maybePort;
			hostPart = hostPart.slice(0, colon);
		}
	}

	if (port !== null && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
		return null;
	}

	const host = normalizeHost(hostPart);
	if (!host) return null;
	// `*` is only meaningful as the whole host or as a leading `*.` label.
	if (host.includes('*') && host !== WILDCARD_ALL && !host.startsWith('*.')) return null;
	// Guard the normalizer's own trailing-dot strip: `*.` must NOT quietly
	// collapse into the everything-wildcard. Only a literally-bare `*`
	// (optionally with a pinned port) means "any public host".
	if (host === WILDCARD_ALL && hostPart !== WILDCARD_ALL) return null;

	return { host, port };
}

/**
 * Accepts an array, a comma/newline-separated string, or undefined and
 * returns the entries that parsed cleanly. Invalid entries are DROPPED
 * (never coerced into something broader) and reported separately by
 * {@link collectInvalidHostPatterns} so settings validation can be loud.
 */
export function parseHostPatterns(raw: unknown): string[] {
	const entries = toEntryList(raw);
	return entries.filter((entry) => parseHostPattern(entry) !== null).map((entry) => entry.trim().toLowerCase());
}

/** The entries that did NOT parse — surfaced by `validateSettings`. */
export function collectInvalidHostPatterns(raw: unknown): string[] {
	return toEntryList(raw).filter((entry) => parseHostPattern(entry) === null);
}

function toEntryList(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
	}
	if (typeof raw === 'string') {
		return raw
			.split(/[\n,]/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return [];
}

/** Effective port for a URL, defaulting by scheme when none is explicit. */
function effectivePort(url: URL): string {
	if (url.port) return url.port;
	return url.protocol === 'https:' ? '443' : '80';
}

/** `scheme://host[:port]/` with the hostname already normalized. */
function normalizedOrigin(url: URL, host: string): string {
	const literal = isIP(host) === 6 ? `[${host}]` : host;
	return `${url.protocol}//${literal}${url.port ? `:${url.port}` : ''}/`;
}

/**
 * Names that always mean "this machine / this network". The shared
 * `isSafeWebhookUrl` guard only knows literal IPs and cloud-metadata
 * aliases, so `http://localhost:3000/` would sail straight past it —
 * these are the lexical complement. The DNS re-check catches them again
 * at resolve time; this list is what makes the SYNCHRONOUS redirect
 * audit able to refuse them too.
 */
const INTERNAL_HOSTNAMES = new Set([
	'localhost',
	'localhost.localdomain',
	'ip6-localhost',
	'ip6-loopback',
	'broadcasthost'
]);

/** Reserved / non-delegated suffixes that never denote a public host. */
const INTERNAL_SUFFIXES = ['.localhost', '.localdomain', '.local', '.internal', '.home.arpa', '.intranet'];

/** True when a hostname is a known loopback / internal-network name. */
export function isInternalHostname(host: string): boolean {
	const normalized = normalizeHost(host);
	if (INTERNAL_HOSTNAMES.has(normalized)) return true;
	return INTERNAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** True when `host`/`port` are covered by a single parsed pattern. */
export function matchesHostPattern(host: string, port: string, pattern: HostPattern): boolean {
	if (pattern.port !== null && pattern.port !== port) return false;
	if (pattern.host === WILDCARD_ALL) return true;
	if (pattern.host.startsWith('*.')) {
		// `*.example.com` covers sub.example.com but NOT the apex — an
		// apex that should be reachable has to be listed explicitly.
		const suffix = pattern.host.slice(1);
		return host.endsWith(suffix) && host.length > suffix.length;
	}
	return host === normalizeHost(pattern.host);
}

/** True when `host`/`port` are covered by ANY entry in the allowlist. */
export function isHostAllowed(host: string, port: string, allowedHosts: readonly string[]): boolean {
	for (const entry of allowedHosts) {
		const pattern = parseHostPattern(entry);
		if (pattern && matchesHostPattern(host, port, pattern)) return true;
	}
	return false;
}

/** Clamp a caller/settings timeout into the supported band. */
export function clampTimeout(value: unknown, fallback = DEFAULT_TIMEOUT_MS): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(numeric)));
}

/**
 * Build the effective policy for a session from plugin settings plus
 * per-session overrides.
 *
 * Two rules are load-bearing and deliberately not configurable away:
 *
 *  1. **Default deny.** No configured hosts ⇒ empty allowlist ⇒ every
 *     navigation is refused. There is no implicit "allow everything".
 *  2. **`allowPrivateNetwork` never combines with `*`.** Opting into the
 *     internal network requires naming the hosts; the wildcard entry is
 *     dropped in that mode so the escape hatch cannot become
 *     "the browser may reach anything on the cluster network".
 */
export function resolveNavigationPolicy(
	settings?: PluginSettings,
	spec?: Pick<BrowserSessionSpec, 'timeoutMs' | 'extraAllowedHosts'>
): BrowserNavigationPolicy {
	const raw = (settings ?? {}) as Record<string, unknown>;

	const fromSettings = parseHostPatterns(raw.allowedHosts ?? readEnvAllowlist());
	const fromSpec = parseHostPatterns(spec?.extraAllowedHosts);
	const allowPrivateNetwork = raw.allowPrivateNetwork === true;

	let allowedHosts = dedupe([...fromSettings, ...fromSpec]);
	if (allowPrivateNetwork) {
		allowedHosts = allowedHosts.filter((entry) => parseHostPattern(entry)?.host !== WILDCARD_ALL);
	}

	const subresourcePolicy = raw.subresourcePolicy === 'allowlist' ? 'allowlist' : 'public-only';
	// Headless is the default and stays the default: only an explicit
	// `headless: false` in settings turns it off.
	const headless = raw.headless !== false;

	return {
		allowedHosts,
		subresourcePolicy,
		allowPrivateNetwork,
		timeoutMs: clampTimeout(spec?.timeoutMs ?? raw.timeoutMs),
		headless
	};
}

/**
 * `PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS` — deployment-level allowlist
 * used when nothing is configured through settings. Still default-deny:
 * an unset variable yields an empty list.
 */
function readEnvAllowlist(): string {
	return process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS ?? '';
}

function dedupe(entries: string[]): string[] {
	return [...new Set(entries)];
}

/** Whether a URL is a top-level navigation or a page sub-resource. */
export type RequestKind = 'document' | 'subresource';

export type UrlVerdict =
	| { readonly allowed: true; readonly host: string; readonly dnsCheckRequired: boolean }
	| { readonly allowed: false; readonly reason: BrowserBlockReason; readonly host?: string };

/**
 * Synchronous, lexical verdict for one URL. Ordered cheapest-first so a
 * malformed or non-HTTP URL never reaches the network stack.
 */
export function classifyUrl(rawUrl: string, policy: BrowserNavigationPolicy, kind: RequestKind): UrlVerdict {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { allowed: false, reason: 'invalid_url' };
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { allowed: false, reason: 'scheme_blocked' };
	}

	// Embedded `user:pass@` is both a credential leak and a well-known
	// allowlist-parser confusion trick (`https://allowed.com@evil.tld`).
	if (url.username || url.password) {
		return { allowed: false, reason: 'credentials_in_url' };
	}

	const host = normalizeHost(url.hostname);
	if (!host) {
		return { allowed: false, reason: 'invalid_url' };
	}

	// The private-network escape hatch applies to top-level navigation,
	// and to sub-resources only when they are allowlist-constrained too.
	// A `public-only` sub-resource is NEVER allowed to reach the internal
	// network, whatever the document policy is.
	const privateAllowed =
		policy.allowPrivateNetwork && (kind === 'document' || policy.subresourcePolicy === 'allowlist');

	// Hand the guard a NORMALIZED origin: the trailing-dot FQDN form
	// (`metadata.google.internal.`) would otherwise miss the guard's
	// metadata-hostname set while still resolving to the same host.
	if (!privateAllowed && (isInternalHostname(host) || !isSafeWebhookUrl(normalizedOrigin(url, host)))) {
		return { allowed: false, reason: 'private_address', host };
	}

	const allowlistApplies = kind === 'document' || policy.subresourcePolicy === 'allowlist';
	if (allowlistApplies && !isHostAllowed(host, effectivePort(url), policy.allowedHosts)) {
		return { allowed: false, reason: 'not_allowlisted', host };
	}

	// Literal IPs already went through the lexical guard above; only
	// hostnames need the DNS-rebinding re-check.
	return { allowed: true, host, dnsCheckRequired: !privateAllowed && isIP(host) === 0 };
}

/**
 * Injection seam so tests never touch real DNS. Production callers omit
 * it and get {@link defaultDnsResolver} — the guard is ON by default and
 * has to be deliberately replaced, never accidentally skipped.
 */
export interface UrlGuardDeps {
	readonly dnsResolver?: DnsResolver;
}

/** `dns.promises.lookup(host, { all: true })`. */
export const defaultDnsResolver: DnsResolver = (hostname) => dns.promises.lookup(hostname, { all: true });

/**
 * Strip credentials out of a URL before it lands in an error message or
 * a log line. Falls back to a truncated raw string for unparseable input.
 */
export function redactUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		url.username = '';
		url.password = '';
		return url.toString();
	} catch {
		return rawUrl.slice(0, 256);
	}
}

/**
 * Full guard: lexical verdict, then a DNS re-check that refuses any
 * hostname resolving to a private address (rebinding defence). Fails
 * CLOSED — an unresolvable host is refused, never optimistically tried.
 *
 * Throws {@link BrowserNavigationBlockedError} with a stable `code`.
 */
export async function assertUrlAllowed(
	rawUrl: string,
	policy: BrowserNavigationPolicy,
	kind: RequestKind,
	deps?: UrlGuardDeps
): Promise<void> {
	const verdict = classifyUrl(rawUrl, policy, kind);
	if (!verdict.allowed) {
		throw new BrowserNavigationBlockedError(verdict.reason, redactUrl(rawUrl));
	}
	if (!verdict.dnsCheckRequired) return;

	const resolver = deps?.dnsResolver ?? defaultDnsResolver;

	let addresses: Awaited<ReturnType<DnsResolver>>;
	try {
		addresses = await resolver(verdict.host);
	} catch (error) {
		throw new BrowserNavigationBlockedError(
			'dns_lookup_failed',
			redactUrl(rawUrl),
			`DNS lookup failed for ${verdict.host}: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw new BrowserNavigationBlockedError(
			'dns_lookup_failed',
			redactUrl(rawUrl),
			`DNS lookup returned no addresses for ${verdict.host}`
		);
	}

	for (const entry of addresses) {
		// Every returned address must be public — Happy Eyeballs / DNS
		// round-robin means "one of them is public" is not good enough.
		// Classify by the ADDRESS, not the reported `family`: a resolver
		// stub that reports the wrong family must not skip a check.
		const kindOfIp = isIP(entry.address);
		const isPrivate =
			kindOfIp === 6
				? isPrivateIPv6(entry.address)
				: kindOfIp === 4
					? isPrivateIPv4(entry.address)
					: // Unparseable address — fail closed.
						true;
		if (isPrivate) {
			throw new BrowserNavigationBlockedError(
				'dns_private_ip',
				redactUrl(rawUrl),
				`${verdict.host} resolved to private address ${entry.address}`
			);
		}
	}
}
