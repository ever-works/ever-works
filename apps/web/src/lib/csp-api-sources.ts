/**
 * The API-related `connect-src` sources the browser CSP must authorise.
 *
 * ## Why this module exists
 *
 * `next.config.ts` (the static `headers()` policy) and `src/proxy.ts` (the
 * middleware policy that overwrites it on every page response) each used to
 * carry a byte-identical copy of this derivation. Two copies of one rule is
 * exactly how the two halves drift apart, so the derivation lives here once
 * and both files call it.
 *
 * Deliberately dependency-free — no path aliases, no `server-only`, no app
 * runtime imports — because `next.config.ts` is compiled and evaluated by
 * Next's own config loader, outside the app's module graph.
 *
 * ## The two origins
 *
 * There are TWO different API origins in play and they are frequently not the
 * same host:
 *
 * 1. `NEXT_PUBLIC_API_URL` — the browser-facing API origin. `lib/fleet-flags.ts`
 *    `resolvePublicApiBaseUrl()` documents why it wins where it is set: `API_URL`
 *    is often an in-cluster address a laptop cannot resolve.
 * 2. `API_URL` — the server-only origin the BFF talks to, and, crucially, the
 *    ONLY value the live-view and streaming-terminal attach-token routes use to
 *    mint the socket URL they hand the browser:
 *      - `app/api/agents/[id]/computer/sessions/[sessionId]/attach-token/route.ts`
 *        → `toComputerSocketUrl(API_URL, wsPath)`
 *      - `app/api/agents/[id]/runs/[runId]/terminal/attach-token/route.ts`
 *        → `API_URL` origin, `http` → `ws`
 *    with `API_URL` itself built from `process.env.API_URL || 'http://localhost:3100'`
 *    in `lib/constants.ts`.
 *
 * `use-computer-attach.ts` opens `new WebSocket(body.wsUrl)` on exactly the URL
 * the BFF returned — the browser never gets to substitute the public origin. So
 * a policy that names only the `NEXT_PUBLIC_API_URL` socket twin authorises the
 * wrong host in every deployment where the two differ, which is every shipped
 * one: `docker-compose.yml`, all `.deploy/k8s` manifests and `apps/web/.env.example`
 * set `API_URL` and never set `NEXT_PUBLIC_API_URL`.
 *
 * Hence `resolveApiCspSocketSources()` emits the socket twin of BOTH origins,
 * de-duplicated — one source when they coincide (the common case, and the only
 * case the CI e2e job exercises), two exact origins when they differ. No
 * wildcard, no bare `ws:` scheme: only the app's own API hosts.
 */

/** Fallback for the browser-facing origin — the public production API. */
const DEFAULT_PUBLIC_API_URL = 'https://api.ever.works';

/**
 * Fallback for the server-only origin. MUST stay in lock-step with
 * `lib/constants.ts` (`process.env.API_URL || 'http://localhost:3100'`),
 * because that is the value the attach-token routes mint `wsUrl` from.
 */
const DEFAULT_SERVER_API_URL = 'http://localhost:3100';

/**
 * Security: every source returned here is interpolated raw into the
 * `connect-src` directive. A scheme+host[:port] and nothing else — no
 * whitespace, quotes, `;` or `*` — so a poisoned env var can never smuggle a
 * directive separator or a wildcard into the policy.
 */
const SAFE_CSP_ORIGIN = /^(?:https?|wss?):\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

/**
 * The browser-facing API origin, for the `http(s)` half of `connect-src`.
 *
 * Unchanged behaviour: `NEXT_PUBLIC_API_URL`'s origin, falling back to the
 * public production API when it is unset or unparseable. Written as a literal
 * `process.env.NEXT_PUBLIC_API_URL` member access on purpose — Next inlines
 * `NEXT_PUBLIC_*` reads at build time by textual substitution, and a dynamic
 * lookup would silently opt out of that.
 */
export function resolveApiCspHost(): string {
    const raw = process.env.NEXT_PUBLIC_API_URL || DEFAULT_PUBLIC_API_URL;
    try {
        return new URL(raw).origin;
    } catch {
        return DEFAULT_PUBLIC_API_URL;
    }
}

/**
 * The origin the attach-token routes actually mint socket URLs from — the
 * server-only `API_URL`, reduced to its origin exactly as
 * `toComputerSocketUrl` does (`lib/api/computer-bff.ts`).
 *
 * Returns `null` for a value that is not an http(s) URL, so nothing outside
 * the two supported schemes can reach the policy.
 */
function resolveBffSocketOrigin(): string | null {
    const raw = process.env.API_URL || DEFAULT_SERVER_API_URL;
    try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    } catch {
        return null;
    }
}

/**
 * The `ws(s)` sources `connect-src` must list for the live view and the
 * streaming terminal to connect.
 *
 * CSP3 scheme-part matching does NOT let an `http:`/`https:` source authorise
 * a `ws:`/`wss:` URL, so the socket origins have to be listed in their own
 * right — without them Chrome refuses the connection ("violates … connect-src"),
 * `new WebSocket()` throws `SecurityError`, and `use-computer-attach.ts` reports
 * `cannot-connect`.
 *
 * Ordered public-origin-first so the emitted directive is stable, and
 * de-duplicated so the usual single-origin deployment emits exactly one source.
 */
export function resolveApiCspSocketSources(): string[] {
    const sources: string[] = [];
    for (const origin of [resolveApiCspHost(), resolveBffSocketOrigin()]) {
        if (!origin) continue;
        const socket = origin.replace(/^http/, 'ws');
        if (SAFE_CSP_ORIGIN.test(socket) && !sources.includes(socket)) sources.push(socket);
    }
    return sources;
}
