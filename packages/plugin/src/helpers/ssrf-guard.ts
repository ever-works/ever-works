import { isIP } from 'node:net';
import * as dns from 'node:dns';

/**
 * Returns true if the given URL is safe to call from server-side delivery
 * code. Blocks private, loopback, link-local, and known cloud-metadata IPs
 * to mitigate SSRF (H-09 / H-10 / H-11 / M-23).
 *
 * Hostname-based URLs that resolve to private addresses are NOT detected
 * here — DNS resolution must be re-checked at call time inside the HTTP
 * client, with re-resolution after redirects. This helper covers the
 * literal-IP cases and the obvious metadata hostnames.
 *
 * For the DNS-aware variant that resolves and re-checks the hostname before
 * issuing a request, use {@link safeFetchWithDnsPin}.
 *
 * Originally lived in `@ever-works/agent/utils/ssrf-guard.ts`; promoted to
 * the shared plugin package so content-extractor / source-validation
 * plugins can reach it. The agent copy now re-exports from here.
 */
export function isSafeWebhookUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return false;
	}

	let host = url.hostname.toLowerCase();
	// Node's URL parser keeps the square brackets around literal IPv6 hosts.
	if (host.startsWith('[') && host.endsWith(']')) {
		host = host.slice(1, -1);
	}

	if (CLOUD_METADATA_HOSTNAMES.has(host)) {
		return false;
	}

	const ipKind = isIP(host);
	if (ipKind === 4 && isPrivateIPv4(host)) return false;
	if (ipKind === 6 && isPrivateIPv6(host)) return false;

	return true;
}

const CLOUD_METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

/**
 * True for any IPv4 address that must never be reachable from server-side
 * webhook / SSRF-sensitive code: RFC1918 private ranges, loopback (127/8),
 * link-local (169.254/16 — includes AWS / GCP / Azure IMDS 169.254.169.254),
 * CGNAT (100.64/10), multicast/reserved (>=224), 0.0.0.0/8, and the
 * IETF-protocol-assignment range 192.0.0/24.
 *
 * Exported so {@link safeFetchWithDnsPin} can reuse the same predicate
 * against DNS-resolved addresses without duplicating the rules.
 */
export function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split('.').map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
	const [a, b] = parts;
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 192 && b === 0 && parts[2] === 0) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a >= 224) return true;
	return false;
}

/**
 * True for any IPv6 address that must never be reachable from server-side
 * webhook / SSRF-sensitive code: loopback (::1), unspecified (::), unique
 * local (fc00::/7 — fc.. / fd..), link-local (fe80::/10), and IPv4-mapped
 * addresses (::ffff:a.b.c.d) where the embedded IPv4 is private.
 *
 * Exported so {@link safeFetchWithDnsPin} can reuse the same predicate
 * against DNS-resolved addresses without duplicating the rules.
 */
export function isPrivateIPv6(ip: string): boolean {
	const lower = ip.toLowerCase();
	if (lower === '::1' || lower === '::') return true;
	if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
	if (lower.startsWith('fe80')) return true;
	if (lower.startsWith('::ffff:')) {
		const v4 = lower.slice('::ffff:'.length);
		if (isIP(v4) === 4) return isPrivateIPv4(v4);
	}
	return false;
}

/**
 * Shape of a single DNS lookup result, matching what
 * `dns.promises.lookup(host, { all: true })` returns. Defined here so the
 * helper can accept an injected resolver in tests without pulling in
 * `@types/node`-specific shapes at call sites.
 */
export interface DnsLookupAddress {
	address: string;
	family: number;
}

/**
 * Resolver contract used by {@link safeFetchWithDnsPin}. Defaults to
 * `dns.promises.lookup(host, { all: true })` in production. Tests inject a
 * deterministic resolver instead of monkey-patching `node:dns`.
 */
export type DnsResolver = (hostname: string) => Promise<DnsLookupAddress[]>;

const defaultDnsResolver: DnsResolver = (hostname) =>
	dns.promises.lookup(hostname, { all: true });

/**
 * Error thrown when {@link safeFetchWithDnsPin} refuses to issue the
 * request. The discriminated `code` lets callers map to a stable error
 * label without parsing a free-form message.
 */
export class SsrfBlockedError extends Error {
	readonly code:
		| 'lexical_blocked'
		| 'dns_lookup_failed'
		| 'dns_no_results'
		| 'dns_private_ip';

	constructor(
		code:
			| 'lexical_blocked'
			| 'dns_lookup_failed'
			| 'dns_no_results'
			| 'dns_private_ip',
		message: string,
	) {
		super(message);
		this.name = 'SsrfBlockedError';
		this.code = code;
	}
}

/**
 * Options for {@link safeFetchWithDnsPin}. The `dnsResolver` hook exists so
 * tests can inject a deterministic resolver without monkey-patching the
 * `node:dns` module globally.
 */
export interface SafeFetchOptions {
	/**
	 * Override the DNS resolver used to enforce the post-resolve guard.
	 * Defaults to `dns.promises.lookup(host, { all: true })`.
	 */
	dnsResolver?: DnsResolver;
}

/**
 * SSRF-hardened `fetch` wrapper that mitigates DNS rebinding (M-23).
 *
 * The plain `isSafeWebhookUrl(url)` check is **lexical only**: a hostname
 * that resolves to a public IP at guard time can resolve to `127.0.0.1`
 * (or `169.254.169.254`) at fetch time, bypassing the check entirely.
 *
 * `safeFetchWithDnsPin` closes the obvious half of that race by:
 *
 *   1. Running `isSafeWebhookUrl(url)` first (rejects literal-IP / metadata
 *      hostnames, non-HTTP(S) schemes, and malformed URLs).
 *   2. Resolving the hostname via the injected (or default) DNS resolver
 *      with `{ all: true }`.
 *   3. Rejecting if **any** returned address is private/loopback/link-local
 *      (incl. cloud-metadata 169.254.169.254) — we don't pick "the public
 *      one and ignore the rest", because Happy Eyeballs / round-robin
 *      could still land on the private address.
 *   4. Issuing the actual `fetch(url, init)`.
 *
 * ## Known partial mitigation
 *
 * This implementation does **not** pin the connection to a specific IP. A
 * sufficiently fast attacker can still race the DNS TTL between step 2 and
 * the underlying socket connect inside `fetch`. Full pinning would require
 * an HTTPS-aware custom dispatcher (e.g. `undici` `Agent` with a
 * `connect` hook that rewrites the host to the literal IP while keeping
 * the original `servername` for SNI/TLS validation). `undici` is not a
 * direct dependency of `@ever-works/plugin`, and silently degrading TLS
 * verification is worse than a tighter race window — so we deliberately
 * stop here.
 *
 * Compared to the previous "no DNS check at all" state this still cuts
 * the attack surface from "any DNS-rebinding host" to "an attacker who can
 * win a millisecond-scale race against the resolver cache". Tracked as a
 * follow-up in the security audit notes.
 */
export async function safeFetchWithDnsPin(
	rawUrl: string,
	init?: RequestInit,
	options?: SafeFetchOptions,
): Promise<Response> {
	if (!isSafeWebhookUrl(rawUrl)) {
		throw new SsrfBlockedError(
			'lexical_blocked',
			'URL rejected by lexical SSRF guard',
		);
	}

	const url = new URL(rawUrl);
	let host = url.hostname.toLowerCase();
	if (host.startsWith('[') && host.endsWith(']')) {
		host = host.slice(1, -1);
	}

	// Literal IPs already went through isSafeWebhookUrl above; skip the DNS
	// step entirely since dns.lookup on an IP literal is a no-op anyway.
	const ipKind = isIP(host);
	if (ipKind !== 0) {
		return fetch(rawUrl, init);
	}

	const resolver = options?.dnsResolver ?? defaultDnsResolver;

	let addresses: DnsLookupAddress[];
	try {
		addresses = await resolver(host);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new SsrfBlockedError(
			'dns_lookup_failed',
			`DNS lookup failed for ${host}: ${message}`,
		);
	}

	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw new SsrfBlockedError(
			'dns_no_results',
			`DNS lookup returned no addresses for ${host}`,
		);
	}

	for (const entry of addresses) {
		const ip = entry.address;
		if (entry.family === 4 && isPrivateIPv4(ip)) {
			throw new SsrfBlockedError(
				'dns_private_ip',
				`${host} resolved to private IPv4 ${ip}`,
			);
		}
		if (entry.family === 6 && isPrivateIPv6(ip)) {
			throw new SsrfBlockedError(
				'dns_private_ip',
				`${host} resolved to private IPv6 ${ip}`,
			);
		}
	}

	return fetch(rawUrl, init);
}
