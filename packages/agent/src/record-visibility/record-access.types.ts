import type { RecordListView, VisibilityAggregate } from '@ever-works/contracts';

/**
 * Who is reading (EW-P1-3, `docs/specs/features/record-visibility/spec.md` §3).
 *
 *   - `user`        — a signed-in person (session, personal API key, Ever ID delegation).
 *   - `integration` — an integration key (`authMethod='integration'`, EW-P1-2). It reads
 *                     every `team` / `organization` row of its pinned Organizations,
 *                     regardless of owner, and never a `private` row.
 */
export type VisibilityPrincipal =
    | { kind: 'user'; userId: string }
    | { kind: 'integration'; organizationIds: readonly string[] };

/**
 * Everything the read predicate needs, resolved ONCE per request by
 * `RecordAccessPolicy.contextFor` so a list query never runs a roster or team lookup
 * per row.
 */
export interface RecordAccessContext {
    principal: VisibilityPrincipal;
    /**
     * The Organization the read is scoped to (`X-Scope-Slug`). `null` = personal scope:
     * personal rows are always `private`, so the read is owner-only, exactly as before.
     */
    organizationId: string | null;
    /** User principal: on the Organization's roster, or the Tenant owner. */
    isOrganizationMember: boolean;
    /** User principal: the Organization's Teams the user is a member of. */
    teamIds: readonly string[];
    /** User principal: Works the user owns or is a member of (`work_members`). */
    workIds: readonly string[];
}

/** Columns and edges the predicate uses for one aggregate. */
export interface VisibilityAggregateShape {
    aggregate: VisibilityAggregate;
    /** `team_resources.resourceType` that points at this aggregate. */
    teamResourceType: string;
    /** A direct team column on the row (tasks). */
    teamColumn?: string;
    /** A direct Work column on the row (tasks, agents). */
    workColumn?: string;
    /** Agents sit on Teams through `team_members` (`memberType='agent'`). */
    teamMemberType?: string;
    /** Missions reach Works through `mission_works`. */
    missionWorks?: boolean;
    /** Tasks have user participants (assignees, approvers, reviewers, watchers). */
    taskParticipants?: boolean;
}

export const VISIBILITY_AGGREGATE_SHAPES: Readonly<
    Record<VisibilityAggregate, VisibilityAggregateShape>
> = {
    task: {
        aggregate: 'task',
        teamResourceType: 'task',
        teamColumn: 'teamId',
        workColumn: 'workId',
        taskParticipants: true,
    },
    goal: { aggregate: 'goal', teamResourceType: 'goal' },
    mission: { aggregate: 'mission', teamResourceType: 'mission', missionWorks: true },
    idea: { aggregate: 'idea', teamResourceType: 'idea' },
    agent: {
        aggregate: 'agent',
        teamResourceType: 'agent',
        workColumn: 'workId',
        teamMemberType: 'agent',
    },
};

/**
 * Which rows a list returns.
 *
 *   - `mine`         — `userId = caller`: exactly today's list (the default).
 *   - `shared`       — rows the caller does NOT own but takes part in or reaches through a
 *                      Team / Work.
 *   - `organization` — every row of the active Organization the caller may read, own rows
 *                      included.
 */
export type VisibilityListView = RecordListView;
