import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { kbAPI } from '@/lib/api/kb';
import { WorkbenchShell } from '@/components/kb/workbench/WorkbenchShell';
import { KbTreePanel } from '@/components/kb/workbench/KbTreePanel';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.kb');
    return { title: t('workbench.metaTitle') };
}

type Params = { params: Promise<{ id: string; locale: string }> };

/**
 * EW-641 slice A — KB workbench index page (no document selected).
 *
 * Server component. Validates Work access via `workAPI.get(id)` and
 * pre-fetches the per-Work doc list server-side so the initial render
 * is "real" even though the workbench tree panel re-fetches the same
 * list client-side for the tab toggle (KB / Originals). When no doc
 * is selected the center pane shows a friendly empty-state — the
 * tree-pane on the left is the operator's entry point for navigating
 * into a specific document.
 *
 * The right (AI) panel slot is intentionally left empty here; slice
 * B fills it in.
 */
export default async function WorkKnowledgeBasePage({ params }: Params) {
    const { id } = await params;
    const t = await getTranslations('dashboard.workDetail.kb');

    try {
        const workResponse = await workAPI.get(id);
        if (!workResponse?.work) notFound();
    } catch {
        notFound();
    }

    // Pre-warm the doc list server-side (cheap — the tree panel will
    // refetch client-side because it owns the KB/Originals tab state).
    await kbAPI.listDocuments(id, { limit: 200 }).catch((error) => {
        console.error('[kb-workbench] failed to pre-fetch KB documents:', error);
        return { items: [], total: 0 };
    });

    return (
        <WorkbenchShell
            left={<KbTreePanel workId={id} />}
            center={
                <div
                    data-testid="kb-workbench-empty"
                    className="flex flex-1 items-center justify-center p-8 text-center text-sm text-text-muted dark:text-text-muted-dark/70"
                >
                    <p className="max-w-md">{t('workbench.empty')}</p>
                </div>
            }
        />
    );
}
