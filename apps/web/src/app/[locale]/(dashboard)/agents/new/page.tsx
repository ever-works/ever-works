import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewAgentDialog } from '@/components/agents';
import { createAgentAction } from '@/app/actions/agents';
import { missionsAPI } from '@/lib/api/missions';
import { workAPI } from '@/lib/api/work';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import type { Mission } from '@/lib/api/missions';
import type { Work } from '@/lib/api/work';
import type { WorkProposal } from '@/lib/api/work-proposals';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.newDialog');
    return { title: t('title') };
}

/**
 * `/agents/new` — server-fetches the user's Mission/Work/Idea
 * catalogs so the NewAgentDialog can offer scope-bound creation
 * (Mission/Work/Idea-scoped Agents) without forcing the user to
 * remember UUIDs. All fetches are defensive (`.catch(() => [])`)
 * so a flaky API doesn't 500 the page — the dialog falls back to
 * tenant-scope only.
 */
export default async function NewAgentPage() {
    const [missions, worksResp, ideas] = await Promise.all([
        missionsAPI.list().catch(() => [] as Mission[]),
        workAPI
            .getAll({ limit: 100 })
            .catch(
                () =>
                    ({ works: [] as Work[], total: 0 }) as {
                        works: Work[];
                        total: number;
                    },
            ),
        workProposalsAPI
            .list(['pending', 'queued', 'building', 'failed', 'accepted'])
            .catch(() => [] as WorkProposal[]),
    ]);

    const missionOptions = missions.map((m) => ({ id: m.id, label: m.title }));
    const workOptions = (worksResp.works ?? []).map((w) => ({
        id: w.id,
        label: w.name ?? w.slug ?? w.id,
    }));
    const ideaOptions = ideas.map((idea) => ({
        id: idea.id,
        label: idea.title ?? idea.description?.slice(0, 80) ?? idea.id,
    }));

    return (
        <NewAgentDialog
            createAgent={createAgentAction}
            missions={missionOptions}
            works={workOptions}
            ideas={ideaOptions}
        />
    );
}
