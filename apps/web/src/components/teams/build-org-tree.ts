import type { OrgChartPayload } from '@/lib/api/teams';

/**
 * Teams & Prebuilt Companies — org-chart tree builder
 * (`docs/specs/features/teams-and-companies/spec.md` §5).
 *
 * Pure function (no React): converts the flat `GET /organizations/:orgId/org-chart`
 * payload into a renderable tree. The server keeps the payload flat by contract;
 * all shaping (team nesting, reports-to chains, deterministic ordering) happens
 * here so it stays unit-testable.
 *
 * Shape rules:
 * - Root = the Organization.
 * - Teams nest via `parentTeamId`; an unknown/dangling parent (or a cyclic
 *   parent chain, defensively) makes the team top-level.
 * - Inside a team: sub-teams first, then the team's agents ordered so an agent
 *   whose `reportsToAgentId` is ALSO in the same team comes after its manager
 *   (simple topological order, cycle-safe), then human members last.
 * - Agents with no (known) team attach under the root; chains of teamless
 *   agents nest under their teamless manager (cycle-safe — an edge that would
 *   close a cycle is dropped and the agent becomes a root-level card).
 * - Members with no (known) team attach under the root, last.
 * - Ordering is deterministic: alphabetical by label (id tiebreak) within rank.
 */

export type OrgTreeNodeKind = 'organization' | 'team' | 'agent' | 'member';

export interface OrgTreeNode {
    id: string;
    kind: OrgTreeNodeKind;
    label: string;
    sublabel?: string | null;
    status?: string | null;
    avatarIcon?: string | null;
    children: OrgTreeNode[];
}

type ChartTeam = OrgChartPayload['teams'][number];
type ChartAgent = OrgChartPayload['agents'][number];
type ChartMember = OrgChartPayload['members'][number];

function compareByLabel(a: OrgTreeNode, b: OrgTreeNode): number {
    const la = a.label.toLowerCase();
    const lb = b.label.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
}

function agentToNode(agent: ChartAgent): OrgTreeNode {
    return {
        id: agent.id,
        kind: 'agent',
        label: agent.name,
        sublabel: agent.title ?? null,
        status: agent.status ?? null,
        avatarIcon: null,
        children: [],
    };
}

function memberToNode(member: ChartMember): OrgTreeNode {
    return {
        id: member.userId,
        kind: 'member',
        label: member.name ?? member.userId,
        sublabel: null,
        status: null,
        avatarIcon: null,
        children: [],
    };
}

function teamToNode(team: ChartTeam): OrgTreeNode {
    return {
        id: team.id,
        kind: 'team',
        label: team.name,
        sublabel: null,
        status: null,
        avatarIcon: team.avatarIcon ?? null,
        children: [],
    };
}

/**
 * Orders a team's agents so that an agent whose manager is in the same team
 * comes after that manager (Kahn-style with an alphabetical tiebreak). When
 * only cyclically-managed agents remain, the alphabetically-first one is
 * emitted anyway so a bad payload can never hang the chart.
 */
function orderTeamAgents(teamAgents: ChartAgent[]): ChartAgent[] {
    const sorted = [...teamAgents].sort((a, b) => compareByLabel(agentToNode(a), agentToNode(b)));
    const remaining = new Map(sorted.map((a) => [a.id, a]));
    const result: ChartAgent[] = [];

    while (remaining.size > 0) {
        let pick: ChartAgent | undefined;
        for (const a of sorted) {
            if (!remaining.has(a.id)) continue;
            const managerStillPending =
                a.reportsToAgentId !== null &&
                a.reportsToAgentId !== a.id &&
                remaining.has(a.reportsToAgentId);
            if (!managerStillPending) {
                pick = a;
                break;
            }
        }
        if (!pick) {
            // Every remaining agent's manager is also remaining — a cycle.
            // Break it deterministically with the alphabetically-first one.
            pick = sorted.find((a) => remaining.has(a.id));
        }
        if (!pick) break; // unreachable — satisfies the type checker
        remaining.delete(pick.id);
        result.push(pick);
    }
    return result;
}

/**
 * Cycle-safe incremental parenting: entries are processed in deterministic
 * (alphabetical) order and an edge is only accepted when walking the
 * already-accepted parent chain from the proposed parent never reaches the
 * child. The accepted graph is always a forest, so the walk always ends.
 * Returns childId → parentId for the accepted edges.
 */
function assignParents(
    ids: string[],
    desiredParentOf: (id: string) => string | null,
): Map<string, string> {
    const known = new Set(ids);
    const parentOf = new Map<string, string>();
    for (const id of ids) {
        const parent = desiredParentOf(id);
        if (!parent || parent === id || !known.has(parent)) continue;
        let cursor: string | undefined = parent;
        let closesCycle = false;
        while (cursor !== undefined) {
            if (cursor === id) {
                closesCycle = true;
                break;
            }
            cursor = parentOf.get(cursor);
        }
        if (closesCycle) continue;
        parentOf.set(id, parent);
    }
    return parentOf;
}

export function buildOrgTree(payload: OrgChartPayload): OrgTreeNode {
    const { organization, teams, agents, members } = payload;

    const knownTeamIds = new Set(teams.map((t) => t.id));
    const teamNodes = new Map(teams.map((t) => [t.id, teamToNode(t)]));

    // ---- Team hierarchy (unknown parent → top-level; cycles broken defensively).
    const sortedTeams = [...teams].sort((a, b) =>
        compareByLabel(teamNodes.get(a.id)!, teamNodes.get(b.id)!),
    );
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const teamParentOf = assignParents(
        sortedTeams.map((t) => t.id),
        (id) => teamById.get(id)?.parentTeamId ?? null,
    );
    const subTeamsOf = new Map<string, OrgTreeNode[]>();
    const topLevelTeamNodes: OrgTreeNode[] = [];
    for (const team of sortedTeams) {
        const node = teamNodes.get(team.id)!;
        const parentId = teamParentOf.get(team.id);
        if (parentId) {
            const list = subTeamsOf.get(parentId) ?? [];
            list.push(node);
            subTeamsOf.set(parentId, list);
        } else {
            topLevelTeamNodes.push(node);
        }
    }

    // ---- Partition agents/members into per-team buckets vs. root-level.
    const effectiveTeamIds = (teamIds: string[]): string[] =>
        teamIds.filter((id) => knownTeamIds.has(id));

    const agentsOfTeam = new Map<string, ChartAgent[]>();
    const teamlessAgents: ChartAgent[] = [];
    for (const agent of agents) {
        const inTeams = effectiveTeamIds(agent.teamIds ?? []);
        if (inTeams.length === 0) {
            teamlessAgents.push(agent);
            continue;
        }
        for (const teamId of inTeams) {
            const list = agentsOfTeam.get(teamId) ?? [];
            list.push(agent);
            agentsOfTeam.set(teamId, list);
        }
    }

    const membersOfTeam = new Map<string, ChartMember[]>();
    const teamlessMembers: ChartMember[] = [];
    for (const member of members) {
        const inTeams = effectiveTeamIds(member.teamIds ?? []);
        if (inTeams.length === 0) {
            teamlessMembers.push(member);
            continue;
        }
        for (const teamId of inTeams) {
            const list = membersOfTeam.get(teamId) ?? [];
            list.push(member);
            membersOfTeam.set(teamId, list);
        }
    }

    // ---- Fill each team node: sub-teams, then topologically-ordered agents, then members.
    for (const team of sortedTeams) {
        const node = teamNodes.get(team.id)!;
        const subTeams = (subTeamsOf.get(team.id) ?? []).sort(compareByLabel);
        const orderedAgents = orderTeamAgents(agentsOfTeam.get(team.id) ?? []).map(agentToNode);
        const memberNodes = (membersOfTeam.get(team.id) ?? [])
            .map(memberToNode)
            .sort(compareByLabel);
        node.children = [...subTeams, ...orderedAgents, ...memberNodes];
    }

    // ---- Teamless agents: reports-to chains under the root (cycle-safe).
    const teamlessNodes = new Map(teamlessAgents.map((a) => [a.id, agentToNode(a)]));
    const sortedTeamless = [...teamlessAgents].sort((a, b) =>
        compareByLabel(teamlessNodes.get(a.id)!, teamlessNodes.get(b.id)!),
    );
    const teamlessById = new Map(teamlessAgents.map((a) => [a.id, a]));
    const agentParentOf = assignParents(
        sortedTeamless.map((a) => a.id),
        (id) => teamlessById.get(id)?.reportsToAgentId ?? null,
    );
    const rootAgentNodes: OrgTreeNode[] = [];
    for (const agent of sortedTeamless) {
        const node = teamlessNodes.get(agent.id)!;
        const managerId = agentParentOf.get(agent.id);
        if (managerId) {
            teamlessNodes.get(managerId)!.children.push(node);
        } else {
            rootAgentNodes.push(node);
        }
    }
    for (const node of teamlessNodes.values()) {
        node.children.sort(compareByLabel);
    }

    // ---- Root: top-level teams, then teamless agent chains, then teamless members.
    return {
        id: organization.id,
        kind: 'organization',
        label: organization.displayName,
        sublabel: organization.slug,
        status: null,
        avatarIcon: null,
        children: [
            ...topLevelTeamNodes.sort(compareByLabel),
            ...rootAgentNodes.sort(compareByLabel),
            ...teamlessMembers.map(memberToNode).sort(compareByLabel),
        ],
    };
}
