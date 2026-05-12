import { workAPI } from '@/lib/api/work';
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
    } catch (error) {
        return NextResponse.json(
            {
                error: error instanceof Error ? error.message : 'failed_to_load_deploy_status',
            },
            { status: 500 },
        );
    }
}
