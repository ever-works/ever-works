import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewAgentDialog } from '@/components/agents';
import { createAgentAction } from '@/app/actions/agents';
import { missionsAPI } from '@/lib/api/missions';
import { teamsAPI } from '@/lib/api/teams';
import { workAPI } from '@/lib/api/work';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';
import { fetchAgentTemplateCatalog } from '@/lib/api/agent-templates.server';
import type { Mission } from '@/lib/api/missions';
import type { Team, TeamsOrganization } from '@/lib/api/teams';
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
    const [missions, worksResp, ideas, templates, orgs] = await Promise.all([
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
        // Optional template-pick step (spec FR-23). Defensive so a cold
        // catalog never 500s the create page.
        fetchAgentTemplateCatalog('agent').catch(() => [] as AstTemplateEntry[]),
        // Teams & Companies spec §4.2/§4.3 — active-org resolution v1:
        // orgs[0] is the active Organization. Defensive: no orgs (or a
        // flaky API) simply hides the Team / Reports-to selects.
        teamsAPI.listOrganizations().catch(() => [] as TeamsOrganization[]),
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

    // Teams & Companies spec §4.3 — the Team / Reports-to catalogs are
    // org-gated: without an active Organization the dialog renders
    // exactly as before (both selects hidden). Reports-to candidates
    // are the user's existing non-archived Agents.
    const activeOrg = orgs[0];
    let teamOptions: Array<{ id: string; label: string }> = [];
    let agentOptions: Array<{ id: string; label: string }> = [];
    if (activeOrg) {
        // Reports-to candidates come from the ORG CHART payload — the
        // org-scoped agent roster — not the user-wide agents list, so a
        // multi-org user never wires a reporting line across organizations
        // (PR #1647 review).
        const [teams, chart] = await Promise.all([
            teamsAPI.list(activeOrg.id).catch(() => [] as Team[]),
            teamsAPI.orgChart(activeOrg.id).catch(() => null),
        ]);
        teamOptions = teams.map((team) => ({ id: team.id, label: team.name }));
        agentOptions = (chart?.agents ?? [])
            .filter((a) => a.status !== 'archived')
            .map((a) => ({ id: a.id, label: a.name }));
    }

    return (
        <NewAgentDialog
            createAgent={createAgentAction}
            missions={missionOptions}
            works={workOptions}
            ideas={ideaOptions}
            templates={templates}
            activeOrgId={activeOrg?.id}
            teams={teamOptions}
            agentOptions={agentOptions}
        />
    );
}
