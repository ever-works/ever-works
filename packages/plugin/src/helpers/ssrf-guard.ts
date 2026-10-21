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
	// A fully-qualified spelling (`metadata.google.internal.`) names the same
	// host — the trailing dot must not walk past the alias list.
	host = host.replace(/\.+$/, '');

	if (CLOUD_METADATA_HOSTNAMES.has(host)) {
		return false;
	}

	const ipKind = isIP(host);
	if (ipKind === 4 && isPrivateIPv4(host)) return false;
	if (ipKind === 6 && isPrivateIPv6(host)) return false;

	return true;
}

// Security: `isSafeWebhookUrl` is a LEXICAL first line of defense — it only
// catches literal IPs and these named metadata aliases. The primary metadata
// IP (169.254.169.254, used by AWS/Azure/GCP) is covered by `isPrivateIPv4`,
// but providers also expose DNS aliases that may resolve to it. List the known
// ones so a lexical-only caller still rejects them; `safeFetchWithDnsPin` adds
// the DNS-resolution check for hostname-based rebinding.
const CLOUD_METADATA_HOSTNAMES = new Set([
	// GCP
	'metadata.google.internal',
	'metadata.goog',
	// AWS
	'instance-data',
	'instance-data.ec2.internal',
	// Azure
	'metadata.azure.internal'
]);

/**
 * True for any IPv4 address that must never be reachable from server-side
 * webhook / SSRF-sensitive code: RFC1918 private ranges, loopback (127/8),
 * link-local (169.254/16 — includes AWS / GCP / Azure IMDS 169.254.169.254),
 * CGNAT (100.64/10), multicast/reserved (>=224), 0.0.0.0/8, the
 * IETF-protocol-assignment range 192.0.0/24, the benchmarking range
 * 198.18/15 (RFC 2544), and the documentation ranges 192.0.2/24,
 * 198.51.100/24 and 203.0.113/24 (RFC 5737) — none is a public destination.
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
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 192 && b === 0 && parts[2] === 2) return true;
	if (a === 198 && b === 51 && parts[2] === 100) return true;
	if (a === 203 && b === 0 && parts[2] === 113) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a >= 224) return true;
	return false;
}

/**
 * The eight 16-bit groups of an IPv6 literal, or `null` when `ip` is not one.
 *
 * Handles `::` compression, a trailing dotted IPv4 quad (`::ffff:1.2.3.4`)
 * and a zone index (`fe80::1%eth0`). The WHATWG URL parser rewrites an
 * embedded dotted quad to hex (`[::ffff:169.254.169.254]` becomes
 * `[::ffff:a9fe:a9fe]`), so every check below works on the groups, never on
 * the spelling.
 */
function parseIPv6Groups(ip: string): number[] | null {
	let text = ip.trim().toLowerCase();
	const zone = text.indexOf('%');
	if (zone >= 0) text = text.slice(0, zone);
	if (isIP(text) !== 6) return null;
	const lastColon = text.lastIndexOf(':');
	const tail = text.slice(lastColon + 1);
	if (tail.includes('.')) {
		if (isIP(tail) !== 4) return null;
		const [a, b, c, d] = tail.split('.').map((part) => Number(part));
		text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
	if (fill < 0) return null;
	const groups = [...head, ...new Array<string>(fill).fill('0'), ...rest].map((group) => parseInt(group, 16));
	if (groups.length !== 8 || groups.some((group) => Number.isNaN(group) || group < 0 || group > 0xffff)) {
		return null;
	}
	return groups;
}

/** Dotted IPv4 from two 16-bit groups. */
function ipv4FromGroups(high: number, low: number): string {
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * The IPv4 address an IPv6 address carries inside it, when it carries one in
 * a form a host or a gateway will actually route to that IPv4 address:
 *
 *  - IPv4-mapped        `::ffff:a.b.c.d`      (`::ffff:hhhh:hhhh`)
 *  - IPv4-translated    `::ffff:0:a.b.c.d`    (RFC 2765)
 *  - IPv4-compatible    `::a.b.c.d`           (`::hhhh:hhhh`, deprecated but parsed)
 *  - NAT64 well-known   `64:ff9b::a.b.c.d`    (RFC 6052, /96)
 *  - 6to4               `2002:hhhh:hhhh::/48` (RFC 3056)
 *  - Teredo             `2001:0::/32`, client address = last 32 bits XOR 0xffffffff
 *
 * `null` when there is none. Exported for tests.
 */
export function embeddedIPv4(ip: string): string | null {
	const g = parseIPv6Groups(ip);
	if (!g) return null;
	const zeros = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
	if (zeros(0, 5) && g[5] === 0xffff) return ipv4FromGroups(g[6], g[7]);
	if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return ipv4FromGroups(g[6], g[7]);
	if (zeros(0, 6) && (g[6] !== 0 || g[7] > 1)) return ipv4FromGroups(g[6], g[7]);
	if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4FromGroups(g[6], g[7]);
	if (g[0] === 0x2002) return ipv4FromGroups(g[1], g[2]);
	if (g[0] === 0x2001 && g[1] === 0) return ipv4FromGroups(g[6] ^ 0xffff, g[7] ^ 0xffff);
	return null;
}

/**
 * True for any IPv6 address that must never be reachable from server-side
 * webhook / SSRF-sensitive code: unspecified (::), loopback (::1), unique
 * local (fc00::/7), link-local (fe80::/10), the deprecated site-local block
 * (fec0::/10), multicast (ff00::/8), documentation (2001:db8::/32), NAT64
 * local-use (64:ff9b:1::/48), and every address that EMBEDS an IPv4 address
 * which is itself private, loopback, link-local or cloud-metadata — mapped,
 * translated, compatible, NAT64, 6to4 and Teredo forms alike (see
 * {@link embeddedIPv4}). The check works on the parsed groups, so
 * `::ffff:169.254.169.254` and its URL-normalized spelling `::ffff:a9fe:a9fe`
 * are the same address here.
 *
 * Exported so {@link safeFetchWithDnsPin} can reuse the same predicate
 * against DNS-resolved addresses without duplicating the rules.
 */
export function isPrivateIPv6(ip: string): boolean {
	const g = parseIPv6Groups(ip);
	if (!g) {
		// Not a parseable IPv6 literal: keep the old prefix checks as a floor.
		const lower = ip.toLowerCase();
		return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd');
	}
	if (g.every((group) => group === 0)) return true;
	if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return true;
	if ((g[0] & 0xfe00) === 0xfc00) return true;
	// Security: link-local is the full fe80::/10 block (fe80:: – febf::), not
	// just the fe80 prefix — masked so fe81–febf are blocked too.
	if ((g[0] & 0xffc0) === 0xfe80) return true;
	if ((g[0] & 0xffc0) === 0xfec0) return true;
	if ((g[0] & 0xff00) === 0xff00) return true;
	if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
	if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
	const v4 = embeddedIPv4(ip);
	if (v4 && isPrivateIPv4(v4)) return true;
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

const defaultDnsResolver: DnsResolver = (hostname) => dns.promises.lookup(hostname, { all: true });

/**
 * Error thrown when {@link safeFetchWithDnsPin} refuses to issue the
 * request. The discriminated `code` lets callers map to a stable error
 * label without parsing a free-form message.
 */
export class SsrfBlockedError extends Error {
	readonly code: 'lexical_blocked' | 'dns_lookup_failed' | 'dns_no_results' | 'dns_private_ip';

	constructor(code: 'lexical_blocked' | 'dns_lookup_failed' | 'dns_no_results' | 'dns_private_ip', message: string) {
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
	options?: SafeFetchOptions
): Promise<Response> {
	if (!isSafeWebhookUrl(rawUrl)) {
		throw new SsrfBlockedError('lexical_blocked', 'URL rejected by lexical SSRF guard');
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
		throw new SsrfBlockedError('dns_lookup_failed', `DNS lookup failed for ${host}: ${message}`);
	}

	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw new SsrfBlockedError('dns_no_results', `DNS lookup returned no addresses for ${host}`);
	}

	for (const entry of addresses) {
		const ip = entry.address;
		if (entry.family === 4 && isPrivateIPv4(ip)) {
			throw new SsrfBlockedError('dns_private_ip', `${host} resolved to private IPv4 ${ip}`);
		}
		if (entry.family === 6 && isPrivateIPv6(ip)) {
			throw new SsrfBlockedError('dns_private_ip', `${host} resolved to private IPv6 ${ip}`);
		}
	}

	return fetch(rawUrl, init);
}
