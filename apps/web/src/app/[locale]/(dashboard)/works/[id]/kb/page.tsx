import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { KbShell } from '@/components/works/detail/kb/KbShell';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.kb');
    return { title: t('title') };
}

type Params = { params: Promise<{ id: string }> };

/**
 * EW-641 Phase 1B/d row 2 — Knowledge Base page shell.
 *
 * Server component. The parent `works/[id]/layout.tsx` already loads
 * the Work via `workAPI.get(id)` and renders `notFound()` when the
 * work doesn't exist, but we re-verify here so a direct deep-link to
 * `/kb` doesn't silently render an empty shell when the workId is
 * bogus. No KB-specific data is fetched yet — the panes hydrate over
 * follow-up tickets (tree → editor → AI panel).
 */
export default async function WorkKnowledgeBasePage({ params }: Params) {
    const { id } = await params;

    try {
        await workAPI.get(id);
    } catch {
        notFound();
    }

    return <KbShell workId={id} />;
}
