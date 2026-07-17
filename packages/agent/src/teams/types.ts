import type { TeamMemberRole, TeamMemberType } from '../entities/team-member.entity';

/**
 * Teams & Prebuilt Companies — service-layer input/output types
 * (`docs/specs/features/teams-and-companies/spec.md` §3, §5).
 */

export interface CreateTeamInput {
    name: string;
    slug?: string;
    description?: string | null;
    parentTeamId?: string | null;
    managerAgentId?: string | null;
    avatarIcon?: string | null;
}

export interface UpdateTeamInput {
    name?: string;
    description?: string | null;
    parentTeamId?: string | null;
    managerAgentId?: string | null;
    avatarIcon?: string | null;
}

export interface AddTeamMemberInput {
    memberType: TeamMemberType;
    memberId: string;
    role?: TeamMemberRole;
}

export interface TeamMemberView {
    id: string;
    memberType: TeamMemberType;
    memberId: string;
    role: TeamMemberRole;
    /** Resolved display name (agent name or user display/username). */
    name: string | null;
    /** Agent title when memberType='agent'. */
    title?: string | null;
    createdAt: Date;
}

/** Flat org-chart payload — the tree is built client-side (spec §5). */
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
        reportsToAgentId: string | null;
        teamIds: string[];
    }>;
    members: Array<{
        userId: string;
        name: string | null;
        teamIds: string[];
    }>;
}

/** Service-enforced structural limits (spec §1.1). */
export const TEAM_MAX_DEPTH = 10;
export const TEAM_HIERARCHY_WALK_LIMIT = 50;
