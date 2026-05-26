import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { NewAgentDialog } from '@/components/agents';
import { createAgentAction } from '@/app/actions/agents';
import { missionsAPI } from '@/lib/api/missions';

type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.newDialog');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-3.
 *
 * Scope-pinned `/missions/[id]/agents/new` — mounts the shared
 * NewAgentDialog with `pinned={ scope: 'mission', missionId }` so the
 * user lands on Step 2 with the parent already chosen. The Mission tab
 * strip links here.
 */
export default async function NewMissionAgentPage({ params }: { params: Params }) {
    const { id } = await params;
    const mission = await missionsAPI.get(id);
    if (!mission) notFound();
    return (
        <NewAgentDialog
            createAgent={createAgentAction}
            pinned={{ scope: 'mission', missionId: id, parentLabel: mission.title }}
        />
    );
}
