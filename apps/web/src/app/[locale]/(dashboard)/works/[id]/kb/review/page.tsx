import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { kbAPI } from '@/lib/api/kb';
import { WorkbenchShell } from '@/components/kb/workbench/WorkbenchShell';
import { WorkbenchUploadCoordinator } from '@/components/kb/workbench/WorkbenchUploadCoordinator';
import { KbSearchPalette } from '@/components/kb/workbench/KbSearchPalette';
import { KbReviewQueue } from '@/components/kb/workbench/KbReviewQueue';
import { KbMemoryHealthPanel } from '@/components/kb/workbench/KbMemoryHealthPanel';
import type { KbDocumentDto } from '@ever-works/contracts';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.kb');
    return { title: t('review.metaTitle') };
}

type Params = { params: Promise<{ id: string; locale: string }> };

/**
 * Memory upgrades M8 — the KB review queue route.
 *
 * Lives inside the existing three-pane workbench (same tree pane on the
 * left, queue in the center) so the review step is part of the KB
 * surface rather than a detached screen. The static `review` segment
 * takes precedence over the sibling `[...path]` catch-all in Next's
 * routing, and no KB document path can collide with it: canonical doc
 * paths are always `<class>/<slug>.md`, i.e. at least two segments.
 *
 * The first page of proposed documents is fetched server-side so the
 * queue renders real content on first paint; `KbReviewQueue` owns every
 * subsequent refresh after an Accept / Supersede / Archive.
 */
export default async function WorkKnowledgeBaseReviewPage({ params }: Params) {
    const { id } = await params;

    try {
        const workResponse = await workAPI.get(id);
        if (!workResponse?.work) notFound();
    } catch {
        notFound();
    }

    let documents: KbDocumentDto[] = [];
    let error: string | null = null;
    try {
        const result = await kbAPI.listDocuments(id, { reviewState: 'proposed', limit: 100 });
        documents = result.items ?? [];
    } catch (err) {
        console.error('[kb-review] failed to pre-fetch proposed KB documents:', err);
        error = err instanceof Error ? err.message : 'Failed to load the review queue';
    }

    return (
        <>
            <KbSearchPalette workId={id} />
            <WorkbenchShell
                left={<WorkbenchUploadCoordinator workId={id} />}
                center={
                    <div className="flex flex-col gap-4">
                        {/* Memory upgrades M10 — the health panel sits ABOVE
                            the queue on purpose: "23 documents waiting, the
                            oldest for 41 days" is the context that makes
                            reviewing the queue feel worth doing, and the
                            gap topics tell the reviewer WHICH proposals
                            actually close a measured hole. */}
                        <KbMemoryHealthPanel />
                        <KbReviewQueue
                            workId={id}
                            initialDocuments={documents}
                            initialError={error}
                        />
                    </div>
                }
            />
        </>
    );
}
