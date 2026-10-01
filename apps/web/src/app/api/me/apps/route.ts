import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * APW-11 T14 — the launcher's BFF read (`GET /api/me/apps`).
 *
 * A thin proxy, and the thinness is the point: the panel is fed by the API's own
 * `GET /api/me/apps` (`apps/api/src/app-launcher/app-launcher.controller.ts:245-273`),
 * so this route must add **nothing** that could make the two disagree — no local
 * filtering, no shaping, no cache of its own.
 *
 * ## Why `bffProxy` and not a hand-rolled `serverFetch`
 *
 * T14's warning is the reason this file is four lines of plumbing instead of
 * twenty: the plan's earlier draft pointed at
 * `apps/web/src/app/api/usage/costs/[section]/route.ts`, which sets only
 * `Authorization`. A request with no scope header is resolved by the API as
 * **personal** scope (`apps/api/src/scope/scope-resolver.middleware.ts:41-45`),
 * so no Organization-scoped Work would ever be listed — silently, as an empty
 * launcher rather than an error.
 *
 * `bffProxy` (`apps/web/src/lib/api/bff-proxy.ts`) is the shared fix for that
 * whole defect class and is what 48 sibling routes use: it reads the token,
 * converts the browser's per-tab `x-ever-workspace` selector into the API's
 * `x-scope-slug` header, **deletes the browser header so it never travels
 * upstream**, and answers **400** when the selector is missing or malformed.
 * `serverFetch` would do the same conversion but throws on a missing selector,
 * which this route would then have to report as a gateway failure — blaming the
 * API for a client bug. The spec asserts the header on the outgoing request
 * rather than trusting this comment.
 *
 * ## Only one query parameter is forwarded
 *
 * `includeHidden` is forwarded **only** as the literal `'true'`/`'false'` the
 * API's `ListAppLauncherQueryDto` accepts (`:163-174`); anything else is dropped
 * here rather than relayed for the API to reject, and no other parameter,
 * header or body field survives the hop, so this route cannot become an open
 * proxy for the platform API. `limit` is deliberately not exposed either: the
 * API's own default (200, its maximum) is what every launcher read wants, and
 * adding a knob no caller needs would be a second source of truth for the
 * panel's length.
 *
 * The token never appears in the upstream URL — it travels in the
 * `Authorization` header `bffProxy` builds — which ACC-11-24's unit half
 * asserts, because a token in a URL ends up in access logs and browser history
 * for no reason.
 *
 * Upstream status and body pass through unchanged: a `404` means the launcher is
 * switched off and must stay a `404` rather than becoming a `200` with an empty
 * list, which the panel would render as "you have no apps".
 */
export const GET = bffProxy(async ({ request, headers }) => {
    const includeHidden = request.nextUrl.searchParams.get('includeHidden');
    const query =
        includeHidden === 'true' || includeHidden === 'false'
            ? `?includeHidden=${includeHidden}`
            : '';

    headers.set('Accept', 'application/json');

    let upstream: Response;
    try {
        upstream = await fetch(`${API_URL}/me/apps${query}`, {
            method: 'GET',
            headers,
            cache: 'no-store',
        });
    } catch {
        // A transport failure is the one case the API itself cannot report.
        // Answering our own 502 keeps the panel's failure state deterministic
        // (an unhandled rejection would surface as an opaque 500), and the
        // message is ours — an upstream error can carry an address or a Work
        // name and is never echoed to the browser.
        return NextResponse.json({ error: 'failed_to_load_apps' }, { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const body = await upstream.text().catch(() => '');
    return new Response(body, {
        status: upstream.status,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
    });
});
