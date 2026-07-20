import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { teamsAPI } from '@/lib/api/teams';
import {
    AgentSettingsClient,
    type AgentSettingsOrganization,
} from '@/components/agents/AgentSettingsClient';
import type { Agent } from '@/lib/api/agents';
import type { Team } from '@/lib/api/teams';

export default async function AgentSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    // Teams & Companies spec §4.3 — Organization card context. Active-org
    // resolution v1: orgs[0]. Every fetch is defensive so a flaky Teams
    // API never 500s the settings page — without an Organization the
    // card simply doesn't render. `currentTeamIds` is derived from the
    // org chart payload (one flat call) instead of N per-team lookups.
    const orgs = await teamsAPI.listOrganizations().catch(() => []);
    const activeOrg = orgs[0];
    let organization: AgentSettingsOrganization | undefined;
    if (activeOrg) {
        const [teams, chart, agentsResp] = await Promise.all([
            teamsAPI.list(activeOrg.id).catch(() => [] as Team[]),
            teamsAPI.orgChart(activeOrg.id).catch(() => null),
            agentsAPI.list({ limit: 100 }).catch(() => ({
                data: [] as Agent[],
                meta: { total: 0, limit: 100, offset: 0 },
            })),
        ]);
        organization = {
            activeOrgId: activeOrg.id,
            teams: teams.map((team) => ({ id: team.id, label: team.name })),
            currentTeamIds: chart?.agents.find((a) => a.id === agent.id)?.teamIds ?? [],
            agentOptions: agentsResp.data
                .filter((a) => a.id !== agent.id && a.status !== 'archived')
                .map((a) => ({ id: a.id, label: a.name })),
        };
    }

    return <AgentSettingsClient agent={agent} organization={organization} />;
}
