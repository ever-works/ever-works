import { workAPI } from '@/lib/api/work';
import { getAuthFromCookie } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { ApiResponseError } from '@/lib/api/server-api';

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
 * (`apps/api/src/app-works/app-upstream.controller.ts:87-101`, ACC-02-21), and
 * this handler forwards that status and body unchanged. An unauthenticated call
 * is answered `401` before any upstream work — the same guard
 * `api/works/[id]/deploy/status/route.ts:33-36` applies.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // Security: require an authenticated session before proxying to the upstream
    // API, rather than relying on the API's own tenant isolation alone.
    const user = await getAuthFromCookie();
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
