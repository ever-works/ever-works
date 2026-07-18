import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Teams & Prebuilt Companies — web-side mirror of the api-side wire shapes
 * (`apps/api/src/teams/teams.controller.ts` TeamResponse/TeamDetailResponse
 * and `@ever-works/agent/teams` OrgChartPayload/TeamMemberView). Kept in
 * lockstep manually, missions-client pattern — dates stay ISO strings.
 */

export type TeamMemberType = 'agent' | 'user';
export type TeamMemberRole = 'lead' | 'member';

export interface Team {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    parentTeamId: string | null;
    managerAgentId: string | null;
    avatarIcon: string | null;
    organizationId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TeamMemberView {
    id: string;
    memberType: TeamMemberType;
    memberId: string;
    role: TeamMemberRole;
    name: string | null;
    title?: string | null;
    createdAt: string;
}

export interface TeamDetail extends Team {
    members: TeamMemberView[];
    childTeamIds: string[];
}

export type TeamResourceType = 'work' | 'task' | 'agent' | 'mission' | 'idea';

export interface TeamResourceItem {
    id: string;
    resourceType: TeamResourceType;
    resourceId: string;
    name: string | null;
    slug: string | null;
    addedById: string | null;
    createdAt: string;
}

export interface TeamResourcesGrouped {
    work: TeamResourceItem[];
    task: TeamResourceItem[];
    agent: TeamResourceItem[];
    mission: TeamResourceItem[];
    idea: TeamResourceItem[];
}

export interface ResourceTeamRef {
    teamId: string;
    name: string;
    slug: string;
}

export interface CreateTeamInput {
    name: string;
    slug?: string;
    description?: string;
    parentTeamId?: string;
    managerAgentId?: string;
    avatarIcon?: string;
}

export interface UpdateTeamInput {
    name?: string;
    description?: string | null;
    parentTeamId?: string | null;
    managerAgentId?: string | null;
    avatarIcon?: string | null;
}

export interface OrgChartPayload {
    organization: { id: string; slug: string; displayName: string };
    teams: Array<{
        id: string;
        slug: string;
        name: string;
        avatarIcon: string | null;
        parentTeamId: string | null;
        managerAgentId: string | null;
    }>;
    agents: Array<{
        id: string;
        name: string;
        title: string | null;
        status: string;
        avatarIcon: string | null;
        reportsToAgentId: string | null;
        teamIds: string[];
    }>;
    members: Array<{ userId: string; name: string | null; avatarUrl: string | null; teamIds: string[] }>;
}

/** Minimal org shape the teams pages need (mirror of OrganizationResponse). */
export interface TeamsOrganization {
    id: string;
    slug: string;
    displayName: string;
}

export const teamsAPI = {
    /** Organizations of the current user's Tenant (server-side). */
    async listOrganizations(): Promise<TeamsOrganization[]> {
        try {
            return await serverFetch<TeamsOrganization[]>('/organizations', { method: 'GET' });
        } catch {
            return [];
        }
    },

    async list(orgId: string): Promise<Team[]> {
        return serverFetch<Team[]>(`/organizations/${orgId}/teams`, { method: 'GET' });
    },

    async get(orgId: string, teamId: string): Promise<TeamDetail | null> {
        try {
            return await serverFetch<TeamDetail>(`/organizations/${orgId}/teams/${teamId}`, {
                method: 'GET',
            });
        } catch {
            return null;
        }
    },

    async create(orgId: string, input: CreateTeamInput): Promise<Team> {
        return serverMutation<Team>({
            endpoint: `/organizations/${orgId}/teams`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(orgId: string, teamId: string, input: UpdateTeamInput): Promise<Team> {
        return serverMutation<Team>({
            endpoint: `/organizations/${orgId}/teams/${teamId}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async remove(orgId: string, teamId: string): Promise<void> {
        await serverMutation<void>({
            endpoint: `/organizations/${orgId}/teams/${teamId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async addMember(
        orgId: string,
        teamId: string,
        input: { memberType: TeamMemberType; memberId: string; role?: TeamMemberRole },
    ): Promise<TeamMemberView> {
        return serverMutation<TeamMemberView>({
            endpoint: `/organizations/${orgId}/teams/${teamId}/members`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async removeMember(
        orgId: string,
        teamId: string,
        memberType: TeamMemberType,
        memberId: string,
    ): Promise<void> {
        await serverMutation<void>({
            endpoint: `/organizations/${orgId}/teams/${teamId}/members/${memberId}?memberType=${memberType}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async orgChart(orgId: string): Promise<OrgChartPayload | null> {
        try {
            return await serverFetch<OrgChartPayload>(`/organizations/${orgId}/org-chart`, {
                method: 'GET',
            });
        } catch {
            return null;
        }
    },

    async listResources(orgId: string, teamId: string): Promise<TeamResourcesGrouped> {
        try {
            return await serverFetch<TeamResourcesGrouped>(
                `/organizations/${orgId}/teams/${teamId}/resources`,
                { method: 'GET' },
            );
        } catch {
            return { work: [], task: [], agent: [], mission: [], idea: [] };
        }
    },

    async attachResource(
        orgId: string,
        teamId: string,
        input: { resourceType: TeamResourceType; resourceId: string },
    ): Promise<TeamResourceItem> {
        return serverMutation<TeamResourceItem>({
            endpoint: `/organizations/${orgId}/teams/${teamId}/resources`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async detachResource(
        orgId: string,
        teamId: string,
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<void> {
        await serverMutation<void>({
            endpoint: `/organizations/${orgId}/teams/${teamId}/resources/${resourceType}/${resourceId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async resourceTeams(
        orgId: string,
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<ResourceTeamRef[]> {
        try {
            return await serverFetch<ResourceTeamRef[]>(
                `/organizations/${orgId}/resource-teams?resourceType=${resourceType}&resourceId=${resourceId}`,
                { method: 'GET' },
            );
        } catch {
            return [];
        }
    },
};
