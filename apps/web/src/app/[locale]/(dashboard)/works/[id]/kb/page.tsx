import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { kbAPI } from '@/lib/api/kb';
import { KbShell } from '@/components/works/detail/kb/KbShell';
import { KbTreePanel } from '@/components/works/detail/kb/KbTreePanel';
import { KbUploadZone } from '@/components/works/detail/kb/KbUploadZone';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.kb');
    return { title: t('title') };
}

type Params = { params: Promise<{ id: string }> };

/**
 * EW-641 Phase 1B/d — Knowledge Base index page.
 *
 * Server component. The parent `works/[id]/layout.tsx` already loads
 * the Work via `workAPI.get(id)` and renders `notFound()` when the
 * work doesn't exist, but we re-verify here so a direct deep-link to
 * `/kb` doesn't silently render an empty shell when the workId is
 * bogus.
 *
 * Row 3 wires the tree panel: we fetch the document metadata list and
 * pass the server-rendered `<KbTreePanel>` into `KbShell` via the
 * `treeSlot` prop. A fetch failure falls back to an empty list so a
 * transient API error still renders the shell with a friendly empty
 * state (same copy operators see when there are 0 docs).
 */
export default async function WorkKnowledgeBasePage({ params }: Params) {
    const { id } = await params;

    try {
        await workAPI.get(id);
    } catch {
        notFound();
    }

    const docs = await kbAPI.listDocuments(id, { limit: 200 }).catch((error) => {
        console.error('[kb-tree] failed to list KB documents:', error);
        return { items: [], total: 0 };
    });

    return (
        <div className="flex flex-col gap-4">
            <KbUploadZone workId={id} />
            <KbShell workId={id} treeSlot={<KbTreePanel workId={id} documents={docs.items} />} />
        </div>
    );
}
