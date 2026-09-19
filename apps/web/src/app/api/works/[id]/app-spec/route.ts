import { workAppSpecAPI } from '@/lib/api/work-app-spec';
import { getAuthFromCookie } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { ApiResponseError } from '@/lib/api/server-api';

/**
 * APW-03 T17 — the browser's read door to `GET /api/works/:id/app-spec`.
 *
 * ## Why this route exists (the decision T16's report left to T17)
 *
 * Plan §5.2 (`plan.md:617`) makes `AppSpecPageClient` poll the App spec every
 * five seconds while `evaluationPending`, at most 24 times. A poll cannot go
 * through a server action: Next.js queues an action behind the one already
 * running, and the thing being polled **is** the job the Re-check action just
 * queued — the same reason `ComparisonGenerationProgress` records for its own
 * poller and the reason APW-02 T30 built
 * `apps/web/src/app/api/works/[id]/upstream/route.ts` for its 5-second poll
 * (`route.ts:9-19`). `workAppSpecAPI` is `server-only` and cannot be called from
 * the browser, and T15 exposed no client-callable read.
 *
 * So the read the poll needs is **this route handler**, not a second server
 * action: it is the shape the sibling App Work surface already uses for the same
 * cadence, it is same-origin (no provider URL and no token ever reaches the
 * browser), and it adds no rule of its own — one read, proxied.
 *
 * ## What it deliberately does not do
 *
 * It does not resolve the session's Work access or the kind itself: the API
 * already answers `404 { status: 'error', code: 'not_found' }` for a Work the
 * caller cannot see — the same answer for missing, invisible and another
 * account's (ACC-03-41) — and `422 notAnAppWork` for the wrong kind
 * (`apps/api/src/works/work-app-spec.controller.ts:408-441`). This handler
 * forwards that status and body unchanged, so the page has one vocabulary.
 * An unauthenticated call is answered `401` before any upstream work, exactly as
 * `api/works/[id]/upstream/route.ts:33-36` does.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // Security: require an authenticated session before proxying to the App spec
    // API, rather than relying on the API's own tenant isolation alone.
    const user = await getAuthFromCookie();
    if (!user) {
        return NextResponse.json({ status: 'error', code: 'unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    try {
        const state = await workAppSpecAPI.get(id);
        return NextResponse.json(state);
    } catch (error) {
        if (error instanceof ApiResponseError) {
            // The refusal is forwarded as the API wrote it: the banner and the
            // problems list render the state, never an error string, so
            // re-wording the API's own code here would be a second vocabulary.
            return NextResponse.json(
                error.details ?? { status: 'error', code: error.code, message: error.message },
                { status: error.statusCode },
            );
        }

        return NextResponse.json({ status: 'error', code: 'failed' }, { status: 500 });
    }
}
