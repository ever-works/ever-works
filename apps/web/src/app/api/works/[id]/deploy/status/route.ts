import { workAPI } from '@/lib/api/work';
import { getAuthFromCookie } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Live deploy status for the Work's Deploy page (EW-610).
 *
 * Returns a minimal status payload polled every 3s by
 * `DeployProgressPanel`. Reuses the existing `GET /works/:id` API and
 * extracts the deploy-relevant fields, so no new platform endpoint is
 * needed and existing auth / multi-tenant rules apply unchanged.
 *
 * Shape:
 *   {
 *     deploymentState: 'INITIALIZING' | 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | null,
 *     deploymentStartedAt: ISO string | null,
 *     website: string | null,
 *     deployProvider: 'k8s' | 'vercel' | null,
 *   }
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // Security: require an authenticated session before proxying to the upstream
    // API, matching the comparisons/generation-status route. Prevents anonymous
    // enumeration of deploy status (state, website URL, provider) for arbitrary
    // work IDs and avoids relying solely on upstream tenant isolation.
    const user = await getAuthFromCookie();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    try {
        const response = await workAPI.get(id);
        const work = response?.work;
        if (!work) {
            return NextResponse.json({ error: 'work_not_found' }, { status: 404 });
        }
        return NextResponse.json({
            deploymentState: work.deploymentState ?? null,
            deploymentStartedAt: work.deploymentStartedAt ?? null,
            website: work.website ?? null,
            deployProvider: work.deployProvider ?? null,
        });
    } catch {
        // Security: return a generic error rather than leaking the raw upstream
        // error message (e.g. ApiResponseError details) to the caller.
        return NextResponse.json({ error: 'failed_to_load_deploy_status' }, { status: 500 });
    }
}
