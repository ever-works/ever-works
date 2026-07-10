import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewSkillDialog } from '@/components/skills/NewSkillDialog';
import { createCustomSkillAction } from '@/app/actions/skills';
import { agentsAPI } from '@/lib/api/agents';
import { missionsAPI } from '@/lib/api/missions';
import { workAPI } from '@/lib/api/work';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';
import { fetchAgentTemplateCatalog } from '@/lib/api/agent-templates.server';
import type { Mission } from '@/lib/api/missions';
import type { Work } from '@/lib/api/work';
import type { WorkProposal } from '@/lib/api/work-proposals';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.skillsPage.newPage');
    return { title: t('title') };
}

/**
 * `/skills/new` — dedicated Skill creation page, mirroring
 * `/agents/new`. Server-fetches the user's Mission/Work/Idea/Agent
 * catalogs so the NewSkillDialog can offer scope-bound creation
 * without forcing the user to remember UUIDs, plus the skill-template
 * catalog for the optional template-pick step. All fetches are
 * defensive (`.catch(() => [])`) so a flaky API doesn't 500 the page
 * — the dialog falls back to tenant-scope only.
 */
export default async function NewSkillPage() {
    const [missions, worksResp, ideas, agentsResp, templates] = await Promise.all([
        missionsAPI.list().catch(() => [] as Mission[]),
        workAPI.getAll({ limit: 100 }).catch(
            () =>
                ({ works: [] as Work[], total: 0 }) as {
                    works: Work[];
                    total: number;
                },
        ),
        workProposalsAPI
            .list(['pending', 'queued', 'building', 'failed', 'accepted'])
            .catch(() => [] as WorkProposal[]),
        agentsAPI.list({ limit: 100 }).catch(() => ({ data: [] })),
        fetchAgentTemplateCatalog('skill').catch(() => [] as AstTemplateEntry[]),
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
    const agentOptions = (agentsResp.data ?? []).map((a) => ({
        id: a.id,
        label: `${a.name} (${a.slug})`,
    }));

    return (
        <NewSkillDialog
            createSkill={createCustomSkillAction}
            missions={missionOptions}
            works={workOptions}
            ideas={ideaOptions}
            agents={agentOptions}
            templates={templates}
        />
    );
}
