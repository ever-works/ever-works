import { notFound } from 'next/navigation';
import { teamsAPI, type Team } from '@/lib/api/teams';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { TeamSettingsClient } from '@/components/teams/TeamSettingsClient';

/**
 * Teams & Prebuilt Companies §4.2 — `/teams/[id]/settings`. Same
 * active-org + data loading shape as the overview page; the full team
 * list feeds the re-parent select (self + descendants are excluded
 * client-side) and the Agent list feeds the manager select.
 */
export default async function TeamSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const orgs = await teamsAPI.listOrganizations();
    if (orgs.length === 0) notFound();
    const org = orgs[0];

    const [team, teams, agentsResp] = await Promise.all([
        teamsAPI.get(org.id, id),
        teamsAPI.list(org.id).catch(() => [] as Team[]),
        agentsAPI.list({ limit: 100 }).catch(() => ({
            data: [] as Agent[],
            meta: { total: 0, limit: 100, offset: 0 },
        })),
    ]);
    if (!team) notFound();

    const agents = agentsResp.data.map((agent) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title,
    }));

    return <TeamSettingsClient org={org} team={team} teams={teams} agents={agents} />;
}
