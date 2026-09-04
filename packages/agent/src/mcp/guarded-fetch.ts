import { safeFetchWithDnsPin, SsrfBlockedError, type DnsResolver } from '../utils/ssrf-guard';

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
        ((url: string, init?: RequestInit) =>
            safeFetchWithDnsPin(
                url,
                init,
                options.dnsResolver ? { dnsResolver: options.dnsResolver } : undefined,
            ));

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
                // Cross-origin: forward the method and nothing else. See the
                // class docstring — an allow-list cannot tell a secret header
                // from a benign one by its name.
                currentInit = {
                    method: REWRITE_TO_GET.has(response.status)
                        ? 'GET'
                        : (currentInit.method ?? 'GET'),
                    redirect: 'manual',
                };
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
