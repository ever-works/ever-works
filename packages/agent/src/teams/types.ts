import type { TeamMemberRole, TeamMemberType } from '../entities/team-member.entity';
import type { TeamResourceType } from '../entities/team-resource.entity';

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
    /** Importer-only provenance (spec §6.2) — not exposed on the HTTP DTO. */
    metadata?: import('../entities/team.entity').TeamMetadata | null;
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
        avatarIcon: string | null;
        reportsToAgentId: string | null;
        teamIds: string[];
    }>;
    members: Array<{
        userId: string;
        name: string | null;
        avatarUrl: string | null;
        teamIds: string[];
    }>;
}

/** Service-enforced structural limits (spec §1.1). */
export const TEAM_MAX_DEPTH = 10;
export const TEAM_HIERARCHY_WALK_LIMIT = 50;

// ── Team ↔ resource association ("some Works belong to some Teams") ──

export interface AttachTeamResourceInput {
    resourceType: TeamResourceType;
    resourceId: string;
}

/** One resolved resource attached to a Team. */
export interface TeamResourceItem {
    /** The `team_resources` row id (used as the remove handle). */
    id: string;
    resourceType: TeamResourceType;
    resourceId: string;
    /** Resolved display name (work/agent name, or mission/idea/task title). */
    name: string | null;
    /** Resolved slug when the resource has one (works/agents/tasks/ideas). */
    slug: string | null;
    addedById: string | null;
    createdAt: Date;
}

/** Attached resources grouped by type (`listForTeam`). Empty arrays, never
 *  missing keys, so the web can render every section unconditionally. */
export interface TeamResourcesGrouped {
    work: TeamResourceItem[];
    task: TeamResourceItem[];
    agent: TeamResourceItem[];
    mission: TeamResourceItem[];
    idea: TeamResourceItem[];
}

/** A Team that owns a given resource (`listTeamsForResource`). */
export interface ResourceTeamRef {
    teamId: string;
    name: string;
    slug: string;
}
