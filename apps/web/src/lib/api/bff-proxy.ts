import { NextRequest, NextResponse } from 'next/server';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from './bff-scope';

/**
 * Wrap a BFF route so it carries the workspace scope BY DEFAULT.
 *
 * ## Why this exists
 *
 * `apps/web/src/app/api/**` is a BFF: the browser calls it, it calls the
 * platform. Since `8f28edca0` an Organization scope reaches the API only from an
 * explicit `X-Scope-Slug` header or an `/api/<slug>/…` path, so the route has to
 * convert the browser's per-tab `x-ever-workspace` selector.
 *
 * Today that conversion is **opt-in**: a route forwards nothing unless its author
 * remembers `applyBffWorkspaceScope`. 10 of 78 route files do. That default
 * produced four production defects in a single day (EW-783, EW-786, EW-787,
 * EW-788), and it produced them silently — the API answers a missing Organization
 * scope with an empty payload and HTTP 200, so the symptom is "my data vanished",
 * never a stack trace.
 *
 * Wrapping a route inverts that: the scope is forwarded unless the route says
 * otherwise, and saying otherwise is a visible argument someone has to defend in
 * review. That mirrors `serverFetch`'s `publicRouteScope: 'personal'` opt-out,
 * which already exists and has not caused this class of bug.
 *
 * ## What it does
 *
 * 1. Reads the encrypted auth cookie and refuses without it. The cookie is
 *    decrypted here and NEVER shipped to the browser.
 * 2. Converts the browser selector into the API scope header, failing closed with
 *    400 when the selector is missing or malformed.
 * 3. Hands the handler a ready `Headers` and the token.
 *
 * ## What it deliberately does NOT do
 *
 * It does not perform the upstream fetch or shape the response. Routes differ too
 * much — some pass the upstream status through, some soften a failure to an empty
 * list on purpose — and hiding that behind a helper would make those choices
 * invisible. This wrapper owns auth and scope only.
 *
 * @example
 * export const GET = bffProxy(async ({ headers }) => {
 *     const upstream = await fetch(`${API_URL}/org-templates`, { headers });
 *     return NextResponse.json(await upstream.json());
 * });
 *
 * @example A route that is genuinely scope-free must say so:
 * export const GET = bffProxy(handler, {
 *     scope: 'none', // reason required — see BffProxyOptions.reason
 *     reason: 'Global plugin catalogue; the handler ignores the Organization.',
 * });
 */
export interface ScopedBffRequest {
    /** The original request, for callers that need the URL or body. */
    readonly request: NextRequest;
    /** Auth + scope headers, ready to forward upstream. */
    readonly headers: Headers;
    /** The decrypted bearer token, for routes that build their own headers. */
    readonly token: string;
}

export interface BffProxyOptions {
    /**
     * `'workspace'` (default) converts the browser's per-tab selector and fails
     * closed without it.
     *
     * `'none'` forwards no scope header at all. Use it ONLY when the upstream
     * handler genuinely ignores the Organization — a global catalogue, a health
     * check. If you are reaching for it because a caller does not send the
     * selector, fix the caller instead: this opt-out makes the request run in the
     * personal scope, which for an Organization-aware handler means silently
     * wrong data, not an error.
     */
    readonly scope?: 'workspace' | 'none';
    /**
     * Required with `scope: 'none'`. Written into the code, not just the commit
     * message, so the next reader can tell a considered exemption from an
     * oversight — the distinction that made the four defects above so hard to see.
     */
    readonly reason?: string;
    /**
     * Response for a request with no auth cookie. Defaults to
     * `401 { error: 'Unauthorized' }`. Some routes deliberately soften this (the
     * org-templates catalogue answers `[]` so its modal skips a step rather than
     * erroring), which is why it is overridable.
     */
    readonly onUnauthorized?: () => NextResponse;
}

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

/**
 * The returned signature depends on whether the route has params, and it has to.
 *
 * Next 16 validates route exports structurally. A DYNAMIC route's second
 * argument must be exactly its context type — `RouteContext | undefined` is
 * rejected with "Expected RouteContext, got RouteContext | undefined", so an
 * optional parameter fails `next build`. A STATIC route has no context, and
 * every route spec in this repo calls the handler directly as `await GET(req)`,
 * so a required second parameter fails `tsc` with TS2554 at those call sites.
 *
 * Neither a required nor an optional parameter satisfies both. Keying the
 * signature off `Ctx` does: omit the type argument for a static route and get a
 * one-parameter handler; pass it for a dynamic route and get the exact
 * two-parameter shape Next expects.
 */
type BffRouteHandler<Ctx> = [Ctx] extends [never]
    ? (request: NextRequest) => Promise<Response>
    : (request: NextRequest, context: Ctx) => Promise<Response>;

export function bffProxy<Ctx = never>(
    handler: (scoped: ScopedBffRequest, context: Ctx) => Promise<Response> | Response,
    options: BffProxyOptions = {},
): BffRouteHandler<Ctx> {
    const { scope = 'workspace', reason, onUnauthorized = unauthorized } = options;

    if (scope === 'none' && !reason?.trim()) {
        // Thrown at module load, so a missing justification fails the build
        // rather than shipping an unexplained exemption.
        throw new Error(
            'bffProxy({ scope: "none" }) requires a `reason` explaining why this route needs no workspace scope.',
        );
    }

    // Built with an optional parameter internally and cast to the public
    // signature above: at runtime Next always passes a context, and a static
    // route simply ignores it.
    const route = async (request: NextRequest, context?: Ctx): Promise<Response> => {
        const token = await getAuthAccessCookie();
        if (!token) return onUnauthorized();

        const base: HeadersInit = { Authorization: `Bearer ${token}` };
        if (scope === 'none') {
            return handler({ request, headers: new Headers(base), token }, context as Ctx);
        }

        let headers: Headers;
        try {
            headers = applyBffWorkspaceScope(request, base);
        } catch {
            return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
        }

        return handler({ request, headers, token }, context as Ctx);
    };

    return route as BffRouteHandler<Ctx>;
}
