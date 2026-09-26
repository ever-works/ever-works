import { workAPI } from '@/lib/api/work';
import { getAuthFromCookie } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { ApiResponseError } from '@/lib/api/server-api';
import { BROWSER_WORKSPACE_SCOPE_HEADER, parseWorkspaceSelector } from '@/lib/workspace-scope';

/**
 * Whether the browser's per-tab selector is missing or does not parse — the
 * exact condition under which `serverFetch` (inside `getAuthFromCookie()`)
 * fails closed with `Invalid workspace scope`, because it runs the same
 * `parseWorkspaceSelector` on the same header (`lib/api/server-api.ts`, the
 * `selectedScope` resolution). `/auth/profile` does not opt out with
 * `publicRouteScope`, so no other throw from that call is a scope failure.
 */
function hasInvalidWorkspaceSelector(request: NextRequest): boolean {
    try {
        parseWorkspaceSelector(request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER));
        return false;
    } catch {
        return true;
    }
}

/**
 * APW-02 T30 — the browser's read door to `GET /api/works/:id/upstream`.
 *
 * ## Why this route exists (provisional seam, and the only one on the read path)
 *
 * The card polls while a sync runs — every five seconds, at most 360 times
 * (plan §5.2, `plan.md:636`). A poll cannot go through a server action: the
 * comment in `ComparisonGenerationProgress` records why the app's own pollers use
 * route handlers instead (Next.js queues a server action behind the one already
 * running, which is exactly the case here — the queued job is what is being
 * polled). `workAPI.getUpstream` is `server-only` and cannot be called from the
 * client, and T29 lists no read action, so this BFF handler is the narrowest
 * seam that makes the documented poll possible. It proxies one read, adds no
 * rule of its own, and is the only new HTTP surface in this task.
 *
 * ## What it deliberately does not do
 *
 * It does not answer 404s for a Work the caller cannot see: the API already
 * does, with `{ status: 'error', code: 'not_found' }`
 * (`AppUpstreamController.getUpstream` in
 * `apps/api/src/app-works/app-upstream.controller.ts`, ACC-02-21), and this
 * handler forwards that status and body unchanged. An unauthenticated call is
 * answered `401` before any upstream work — the same `getAuthFromCookie()`
 * guard that opens the `GET` in `api/works/[id]/deploy/status/route.ts`.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // Security: require an authenticated session before proxying to the upstream
    // API, rather than relying on the API's own tenant isolation alone.
    //
    // The workspace-scope resolution happens INSIDE `getAuthFromCookie()`
    // (`serverFetch` → `parseWorkspaceSelector`), and it fails closed when the
    // browser's per-tab `x-ever-workspace` selector is absent or does not parse.
    // That throw used to escape this handler — the call sits before the `try`
    // below — so a caller without the selector got an EMPTY 500 (measured on the
    // e2e lane, `e2e/flow-app-spec-settings.spec.ts`'s poll-read case), where every
    // `bffProxy`-built route and the sibling `app-spec/route.ts` answer the
    // documented `400 { error: 'Invalid workspace scope' }`
    // (`bffProxy`'s catch around `applyBffWorkspaceScope` in `lib/api/bff-proxy.ts`).
    // The card's own poll is unaffected:
    // `browserApiFetch` always sends the selector.
    //
    // ONLY that failure is a 400. `bffProxy` keeps its `try` around the scope
    // resolution alone; here the resolution is buried in `getAuthFromCookie()`,
    // which also rethrows an `/auth/profile` 5xx, so the catch re-checks the
    // selector and lets anything else escape exactly as it did before the catch
    // existed (Next answers 500). An anonymous caller still gets 401 whatever
    // the selector: no session means no profile read, so nothing is resolved.
    let user;
    try {
        user = await getAuthFromCookie();
    } catch (error) {
        if (hasInvalidWorkspaceSelector(request)) {
            return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
        }
        throw error;
    }
    if (!user) {
        return NextResponse.json({ status: 'error', code: 'unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    try {
        const state = await workAPI.getUpstream(id);
        return NextResponse.json(state);
    } catch (error) {
        if (error instanceof ApiResponseError) {
            // The refusal is forwarded as the API wrote it — the code is what the
            // card renders (`not_found` here, `sync_paused`/`not_ready` on the
            // POSTs), so re-wording it would be a second vocabulary.
            return NextResponse.json(
                error.details ?? { status: 'error', code: error.code, message: error.message },
                { status: error.statusCode },
            );
        }

        return NextResponse.json({ status: 'error', code: 'failed' }, { status: 500 });
    }
}
