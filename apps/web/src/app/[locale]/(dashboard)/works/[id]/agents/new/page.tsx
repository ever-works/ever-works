import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { NewAgentDialog } from '@/components/agents';
import { createAgentAction } from '@/app/actions/agents';
import { workAPI } from '@/lib/api/work';

type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.newDialog');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-3.
 *
 * Scope-pinned `/works/[id]/agents/new` — mounts the shared
 * NewAgentDialog with `pinned={ scope: 'work', workId }`. The Work
 * detail layout's "+ New Agent" affordance links here.
 */
export default async function NewWorkAgentPage({ params }: { params: Params }) {
    const { id } = await params;
    let workName: string | null = null;
    try {
        const res = await workAPI.get(id);
        workName = res?.work?.name ?? null;
    } catch {
        notFound();
    }
    if (!workName) notFound();
    return (
        <NewAgentDialog
            createAgent={createAgentAction}
            pinned={{ scope: 'work', workId: id, parentLabel: workName }}
        />
    );
}
