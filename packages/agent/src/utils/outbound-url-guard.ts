import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateIPv4, isPrivateIPv6, isSafeWebhookUrl, type DnsResolver } from './ssrf-guard';

/**
 * Prompt-injection hardening — may a MODEL-supplied URL be fetched server-side?
 *
 * `isSafeWebhookUrl` is lexical: it catches literal private IPs and a few
 * metadata names, and its own docstring says a hostname that RESOLVES to a
 * private address is not detected. A tool such as `extractContent` hands the
 * URL to a (possibly self-hosted) fetcher, so an injected instruction could
 * name `localhost`, `metadata.internal`, `redis.default.svc.cluster.local`, a
 * single-label intranet host, or any public name pointed at 127.0.0.1 /
 * 169.254.169.254 — and read the answer back into the conversation.
 *
 * This check, in order:
 *   1. runs the lexical guard (scheme, literal private IPs, metadata names);
 *   2. refuses hostnames that only ever mean "inside": `localhost`, single-label
 *      names, and the reserved / cluster-internal suffixes below;
 *   3. resolves the name and refuses if ANY address is private, loopback,
 *      link-local (incl. cloud metadata), CGNAT or reserved — not "pick the
 *      public one", because the fetcher may connect to any of them;
 *   4. fails CLOSED when the name does not resolve.
 *
 * It answers a reason string (refuse) or `null` (fetch may proceed). A fetcher
 * that resolves the name again could still be raced by DNS rebinding — the
 * extractor plugin's own fetch should pin the address too; that lives in the
 * plugin package, outside this check.
 */

/** Hostnames that are never public. */
const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'broadcasthost',
    'kubernetes',
    'kubernetes.default',
    'host.docker.internal',
    'gateway.docker.internal',
]);

/** Suffixes reserved for private, link-local or cluster-internal names. */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
    '.localhost',
    '.local',
    '.localdomain',
    '.internal',
    '.intranet',
    '.lan',
    '.home',
    '.corp',
    '.home.arpa',
    '.svc',
    '.cluster.local',
    '.in-addr.arpa',
    '.ip6.arpa',
];

export interface PublicFetchTargetOptions {
    /** Override the resolver (tests). Defaults to `dns.promises.lookup(host, { all: true })`. */
    dnsResolver?: DnsResolver;
}

const defaultResolver: DnsResolver = (hostname) => dnsLookup(hostname, { all: true });

/** The reason `rawUrl` may not be fetched server-side, or `null` when it may. */
export async function publicFetchTargetRefusal(
    rawUrl: string,
    options: PublicFetchTargetOptions = {},
): Promise<string | null> {
    if (!isSafeWebhookUrl(rawUrl)) {
        return 'must be an http(s) URL to a public host (private, loopback, link-local and cloud-metadata addresses are blocked)';
    }
    let host = new URL(rawUrl).hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    while (host.endsWith('.')) host = host.slice(0, -1);
    if (!host) return 'has no host';

    // A literal IP already passed the lexical guard above.
    if (isIP(host) !== 0) return null;

    if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return `names an internal host (${host})`;
    }
    if (!host.includes('.')) {
        // A single-label name only resolves through a local search domain.
        return `names an internal host (${host})`;
    }

    let addresses: { address: string; family: number }[];
    try {
        addresses = await (options.dnsResolver ?? defaultResolver)(host);
    } catch {
        return `could not be resolved (${host})`;
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
        return `could not be resolved (${host})`;
    }
    for (const entry of addresses) {
        const privateAddress =
            entry.family === 6 || isIP(entry.address) === 6
                ? isPrivateIPv6(entry.address)
                : isPrivateIPv4(entry.address);
        if (privateAddress) {
            return `resolves to a private or internal address (${host})`;
        }
    }
    return null;
}
