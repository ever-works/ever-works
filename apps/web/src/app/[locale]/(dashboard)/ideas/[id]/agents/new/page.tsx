import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { NewAgentDialog } from '@/components/agents';
import { createAgentAction } from '@/app/actions/agents';
import { workProposalsAPI } from '@/lib/api/work-proposals';

type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.newDialog');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-3.
 *
 * Scope-pinned `/ideas/[id]/agents/new` — mounts the shared
 * NewAgentDialog with `pinned={ scope: 'idea', ideaId }`. The Idea
 * detail page's "+ New Agent" affordance links here.
 */
export default async function NewIdeaAgentPage({ params }: { params: Params }) {
    const { id } = await params;
    const idea = await workProposalsAPI.get(id).catch(() => null);
    if (!idea) notFound();
    return (
        <NewAgentDialog
            createAgent={createAgentAction}
            pinned={{ scope: 'idea', ideaId: id, parentLabel: idea.title }}
        />
    );
}
