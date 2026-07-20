import { notFound } from 'next/navigation';
import { teamsAPI, type Team, type TeamResourcesGrouped } from '@/lib/api/teams';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { getWorks } from '@/app/actions/dashboard/works';
import { TeamDetailClient } from '@/components/teams/TeamDetailClient';
import type { ResourceOption } from '@/components/teams/TeamResourcesSection';

/**
 * Teams & Prebuilt Companies §4.2 — `/teams/[id]` overview. Active-org
 * v1 resolution (`orgs[0]`); a team can only exist inside an org, so
 * zero orgs — like an unknown team id — is a `notFound()`. The full
 * team list rides along for parent/sub-team name resolution and the
 * Agent list feeds the add-member + manager displays; both defensive.
 */
export default async function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const orgs = await teamsAPI.listOrganizations();
    if (orgs.length === 0) notFound();
    const org = orgs[0];

    const emptyResources: TeamResourcesGrouped = {
        work: [],
        task: [],
        agent: [],
        mission: [],
        idea: [],
    };

    const [team, teams, agentsResp, resources, worksResp] = await Promise.all([
        teamsAPI.get(org.id, id),
        teamsAPI.list(org.id).catch(() => [] as Team[]),
        agentsAPI.list({ limit: 100 }).catch(() => ({
            data: [] as Agent[],
            meta: { total: 0, limit: 100, offset: 0 },
        })),
        teamsAPI.listResources(org.id, id).catch(() => emptyResources),
        getWorks({ limit: 100, offset: 0 }).catch(() => ({ success: false, works: [], total: 0 })),
    ]);
    if (!team) notFound();

    const agents = agentsResp.data.map((agent) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title,
    }));

    const works: ResourceOption[] = (worksResp.works ?? []).map((work) => ({
        id: work.id,
        name: work.name,
        subtitle: work.slug ?? null,
    }));

    return (
        <TeamDetailClient
            org={org}
            team={team}
            teams={teams}
            agents={agents}
            resources={resources}
            works={works}
        />
    );
}
