import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
    isPrivateIPv4,
    isPrivateIPv6,
    isSafeWebhookUrl,
    SsrfBlockedError,
    type DnsResolver,
} from '../utils/ssrf-guard';

/**
 * SSRF- and redirect-hardened `fetch` for the MCP client (AP-15).
 *
 * ## What was open before this
 *
 * `McpConnectionsService.assertValidUrl` applies `isSafeWebhookUrl`, which is
 * **lexical only** — its own docstring says a hostname resolving to a private
 * address is not detected. The SDK transports then used the global `fetch`,
 * which follows redirects automatically. Two consequences, both reachable by
 * anyone who controls a connection URL — including, once packages can declare
 * servers, a package author:
 *
 * 1. **DNS rebinding.** `evil.example.com` passes the lexical guard and
 *    resolves to `169.254.169.254` at fetch time.
 * 2. **Redirect to a private address, carrying credentials.** The server
 *    answers `302 Location: http://127.0.0.1:6379/`, and the default fetch
 *    follows it. `Authorization` is stripped by the platform on a cross-origin
 *    redirect, but custom headers — `X-API-Key`, `X-Auth-Token`, the shapes an
 *    MCP server actually uses — are **not**. The credential is delivered to
 *    whatever host the redirect names.
 *
 * ## What this does
 *
 * Every hop is re-checked, and no hop is taken implicitly:
 *
 * - `redirect: 'manual'`, so redirects are followed HERE rather than by the
 *   platform, which is the only way to inspect each target before going.
 * - each target passes `safeFetchWithDnsPin`, so the lexical guard AND the
 *   post-resolution address check run again per hop.
 * - **crossing origin drops every caller-supplied header.** Not just the ones
 *   that look like credentials: a header allow-list would have to predict
 *   which of an arbitrary MCP server's headers are sensitive, and the answer
 *   for `X-Api-Key` versus `X-Request-Id` is not knowable from the name. The
 *   safe default is to forward nothing and let a genuinely cross-origin
 *   server ask for its own auth.
 */

/** Enough for a legitimate canonicalisation chain, few enough to bound the work. */
export const MAX_REDIRECTS = 5;

/** Status codes that mean "go somewhere else". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Codes after which the request must become a bodyless GET.
 *
 * 303 says so explicitly; 301 and 302 are specified to preserve the method but
 * every real client rewrites POST to GET, and servers are built expecting it.
 */
const REWRITE_TO_GET = new Set([301, 302, 303]);

/**
 * Resolve a host, validate every address, and CONNECT TO THE ONE VALIDATED.
 *
 * `safeFetchWithDnsPin` does the first two steps correctly — it rejects the
 * lookup if any returned address is private — and then calls
 * `fetch(rawUrl, init)`, which resolves the hostname AGAIN. Its own docstring
 * says as much: it "closes the obvious half of that race". The half left open
 * is the one that matters: a name the attacker controls can answer publicly
 * for the validation lookup and privately for the connection a moment later,
 * and nothing in between notices.
 *
 * Pinning closes it by taking the address out of the connection's hands. The
 * URL, and therefore the `Host` header and the TLS SNI, are untouched — so
 * certificate validation still happens against the hostname, and a pinned
 * connection to a host presenting the wrong certificate still fails.
 *
 * A literal-IP URL skips DNS entirely: there is no name to rebind, and the
 * lexical guard has already judged the address.
 */
export async function pinnedFetch(
    url: string,
    init: RequestInit | undefined,
    resolver: DnsResolver | undefined,
): Promise<Response> {
    if (!isSafeWebhookUrl(url)) {
        throw new SsrfBlockedError('lexical_blocked', 'URL rejected by lexical SSRF guard');
    }

    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1);
    }

    // A literal address was already judged above and cannot be rebound.
    if (isIP(host) !== 0) {
        return fetch(url, init);
    }

    let addresses: { address: string; family: number }[];
    try {
        addresses = resolver
            ? await resolver(host)
            : await dnsLookup(host, { all: true, verbatim: true });
    } catch (err) {
        throw new SsrfBlockedError(
            'dns_lookup_failed',
            `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new SsrfBlockedError(
            'dns_no_results',
            `DNS lookup returned no addresses for ${host}`,
        );
    }

    // EVERY address, not the one we happen to pick. A response mixing a public
    // and a private record would otherwise pass whenever the public one is
    // chosen, which is a coin toss rather than a control.
    for (const entry of addresses) {
        if (entry.family === 4 && isPrivateIPv4(entry.address)) {
            throw new SsrfBlockedError(
                'dns_private_ip',
                `${host} resolved to private IPv4 ${entry.address}`,
            );
        }
        if (entry.family === 6 && isPrivateIPv6(entry.address)) {
            throw new SsrfBlockedError(
                'dns_private_ip',
                `${host} resolved to private IPv6 ${entry.address}`,
            );
        }
    }

    const pinned = addresses[0];
    const { Agent } = await import('undici');
    const dispatcher = new Agent({
        connect: {
            // Hand back only the address just validated. undici still uses the
            // URL's hostname for SNI and the Host header, so TLS verification
            // is unchanged.
            lookup: (
                _hostname: string,
                _options: unknown,
                callback: (err: Error | null, address: string, family: number) => void,
            ) => callback(null, pinned.address, pinned.family),
        },
    });

    try {
        return await fetch(url, { ...init, dispatcher } as RequestInit);
    } finally {
        await dispatcher.close().catch(() => undefined);
    }
}

export interface GuardedFetchOptions {
    /** Injected in tests so no DNS or network is required. */
    dnsResolver?: DnsResolver;
    /** Injected in tests; defaults to the DNS-pinned fetch. */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export type GuardedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function headerEntries(init: RequestInit | undefined): [string, string][] {
    const headers = init?.headers;
    if (!headers) return [];
    if (headers instanceof Headers) return [...headers.entries()];
    if (Array.isArray(headers)) return headers.map(([k, v]) => [k, v]);
    return Object.entries(headers as Record<string, string>);
}

/**
 * Build a fetch that re-validates every hop and never forwards caller headers
 * across an origin boundary.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): GuardedFetch {
    const doFetch =
        options.fetchImpl ??
        ((url: string, init?: RequestInit) => pinnedFetch(url, init, options.dnsResolver));

    return async function guardedFetch(input, init) {
        let currentUrl = typeof input === 'string' ? input : input.toString();
        let currentInit: RequestInit = { ...init, redirect: 'manual' };
        const origin = new URL(currentUrl).origin;

        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            const response = await doFetch(currentUrl, currentInit);

            if (!REDIRECT_STATUSES.has(response.status)) {
                return response;
            }

            const location = response.headers.get('location');
            if (!location) {
                // A redirect status with nowhere to go is the server's
                // problem; hand it back rather than inventing a target.
                return response;
            }

            if (hop === MAX_REDIRECTS) {
                throw new SsrfBlockedError(
                    'lexical_blocked',
                    `Too many redirects (more than ${MAX_REDIRECTS}) starting from ${origin}`,
                );
            }

            const target = new URL(location, currentUrl);

            if (target.origin !== origin) {
                // Cross-origin: forward nothing the caller supplied. See the
                // class docstring — an allow-list cannot tell a secret header
                // from a benign one by its name.
                //
                // The body goes too, and that forces the method. A 307/308
                // preserves the method by definition, so keeping POST while
                // dropping the body would send a bodyless POST to a host the
                // caller never addressed — a request neither side asked for,
                // and one a server may act on. Dropping to GET makes the hop
                // a plain retrieval, which is the only thing that can be said
                // to be safe without the caller's data.
                currentInit = { method: 'GET', redirect: 'manual' };
            } else if (REWRITE_TO_GET.has(response.status)) {
                currentInit = {
                    ...currentInit,
                    method: 'GET',
                    body: undefined,
                    redirect: 'manual',
                };
            }

            currentUrl = target.toString();
            // The next iteration re-runs `safeFetchWithDnsPin`, so the new
            // target gets the lexical guard and the DNS check afresh.
        }

        // Unreachable: the loop either returns or throws.
        throw new SsrfBlockedError('lexical_blocked', 'Redirect handling fell through');
    };
}

/** Exported for tests that need to assert what a cross-origin hop keeps. */
export function survivingHeaders(
    init: RequestInit | undefined,
    crossOrigin: boolean,
): [string, string][] {
    return crossOrigin ? [] : headerEntries(init);
}
