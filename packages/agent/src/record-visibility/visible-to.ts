import type { RecordListView, VisibilityAggregate } from '@ever-works/contracts';
import { VISIBILITY_AGGREGATE_SHAPES, type RecordAccessContext } from './record-access.types';

/** A WHERE fragment plus its named parameters, for a TypeORM query builder. */
export interface VisibilitySqlPredicate {
    clause: string;
    parameters: Record<string, unknown>;
}

export interface VisibleToOptions {
    /** The query builder alias of the aggregate's table (e.g. `task`). */
    alias: string;
    aggregate: VisibilityAggregate;
    context: RecordAccessContext;
    /**
     * `mine` = owner only (today's list); `shared` = readable rows the caller does not
     * own, through participation or a Team / Work; `organization` (also used for a get
     * by id) = every readable row.
     */
    view: RecordListView;
    /** The driver's identifier quoting (`qb.connection.driver.escape`). */
    escape: (identifier: string) => string;
    /** Keeps parameters unique when the predicate is composed more than once. */
    parameterPrefix?: string;
}

const NOTHING = '1 = 0';
const SHARED_VISIBILITIES = ['team', 'organization'];

/**
 * `visibleTo(principal)` — the ONE read predicate for tasks, goals, missions, ideas
 * and agents (EW-P1-3, `docs/specs/features/record-visibility/spec.md` §3). Every
 * list and get path composes it in place of its old `userId = caller` filter.
 *
 * A user reads a row when they:
 *   1. own it (today's rule — the only rule in personal scope);
 *   2. take part in it (tasks: user assignee, approver, reviewer or watcher), at any
 *      visibility;
 *   3. reach it through a Team (`teamId`, `team_resources`, an agent's `team_members`)
 *      or a Work they own or belong to (`workId`, `mission_works`), when it is `team`
 *      or `organization`;
 *   4. are a member of its Organization (roster or Tenant owner), when it is
 *      `organization`.
 *
 * An integration principal reads every `team` / `organization` row of its pinned
 * Organizations, regardless of owner, and never a `private` one.
 *
 * Main-alias columns are written `alias.property` so TypeORM quotes them; the tables
 * of the sub-queries are quoted with the driver's `escape`, so the clause is valid on
 * Postgres, MySQL and SQLite.
 */
export function visibleToPredicate(options: VisibleToOptions): VisibilitySqlPredicate {
    const { alias: a, aggregate, context, view, escape: e } = options;
    const p = options.parameterPrefix ?? 'vis';
    const shape = VISIBILITY_AGGREGATE_SHAPES[aggregate];
    const parameters: Record<string, unknown> = {};

    if (context.principal.kind === 'integration') {
        const pinned = context.organizationId
            ? context.principal.organizationIds.filter((id) => id === context.organizationId)
            : [...context.principal.organizationIds];
        if (pinned.length === 0) return { clause: NOTHING, parameters };
        parameters[`${p}Pinned`] = pinned;
        parameters[`${p}SharedVis`] = SHARED_VISIBILITIES;
        return {
            clause:
                `(${a}.organizationId IN (:...${p}Pinned)` +
                ` AND ${a}.visibility IN (:...${p}SharedVis))`,
            parameters,
        };
    }

    parameters[`${p}Me`] = context.principal.userId;
    const owner = `${a}.userId = :${p}Me`;
    if (view === 'mine') return { clause: owner, parameters };

    // Personal scope: every personal row is private, so nothing but ownership applies.
    if (!context.organizationId) {
        return { clause: view === 'shared' ? NOTHING : owner, parameters };
    }
    parameters[`${p}Org`] = context.organizationId;
    const inOrg = `${a}.organizationId = :${p}Org`;

    const reach: string[] = [];

    if (shape.taskParticipants) {
        const id = `${a}.id`;
        reach.push(
            `EXISTS (SELECT 1 FROM ${e('task_assignees')} ${p}_ta WHERE ${p}_ta.${e('taskId')} = ${id}` +
                ` AND ${p}_ta.${e('assigneeType')} = 'user' AND ${p}_ta.${e('assigneeId')} = :${p}Me)`,
            `EXISTS (SELECT 1 FROM ${e('task_approvers')} ${p}_tp WHERE ${p}_tp.${e('taskId')} = ${id}` +
                ` AND ${p}_tp.${e('approverType')} = 'user' AND ${p}_tp.${e('approverId')} = :${p}Me)`,
            `EXISTS (SELECT 1 FROM ${e('task_reviewers')} ${p}_tr WHERE ${p}_tr.${e('taskId')} = ${id}` +
                ` AND ${p}_tr.${e('reviewerType')} = 'user' AND ${p}_tr.${e('reviewerId')} = :${p}Me)`,
            `EXISTS (SELECT 1 FROM ${e('task_watchers')} ${p}_tw WHERE ${p}_tw.${e('taskId')} = ${id}` +
                ` AND ${p}_tw.${e('userId')} = :${p}Me)`,
        );
    }

    const connected: string[] = [];
    if (context.teamIds.length > 0) {
        parameters[`${p}Teams`] = [...context.teamIds];
        parameters[`${p}ResType`] = shape.teamResourceType;
        if (shape.teamColumn) {
            connected.push(`${a}.${shape.teamColumn} IN (:...${p}Teams)`);
        }
        connected.push(
            `EXISTS (SELECT 1 FROM ${e('team_resources')} ${p}_res WHERE ${p}_res.${e('resourceType')} = :${p}ResType` +
                ` AND ${p}_res.${e('resourceId')} = ${a}.id AND ${p}_res.${e('teamId')} IN (:...${p}Teams))`,
        );
        if (shape.teamMemberType) {
            parameters[`${p}MemberType`] = shape.teamMemberType;
            connected.push(
                `EXISTS (SELECT 1 FROM ${e('team_members')} ${p}_tm WHERE ${p}_tm.${e('memberType')} = :${p}MemberType` +
                    ` AND ${p}_tm.${e('memberId')} = ${a}.id AND ${p}_tm.${e('teamId')} IN (:...${p}Teams))`,
            );
        }
    }
    if (context.workIds.length > 0) {
        parameters[`${p}Works`] = [...context.workIds];
        if (shape.workColumn) {
            connected.push(`${a}.${shape.workColumn} IN (:...${p}Works)`);
        }
        if (shape.missionWorks) {
            connected.push(
                `EXISTS (SELECT 1 FROM ${e('mission_works')} ${p}_mw WHERE ${p}_mw.${e('missionId')} = ${a}.id` +
                    ` AND ${p}_mw.${e('workId')} IN (:...${p}Works))`,
            );
        }
    }
    if (connected.length > 0) {
        parameters[`${p}SharedVis`] = SHARED_VISIBILITIES;
        reach.push(`(${a}.visibility IN (:...${p}SharedVis) AND (${connected.join(' OR ')}))`);
    }

    if (view === 'shared') {
        if (reach.length === 0) return { clause: NOTHING, parameters };
        return {
            clause: `(${a}.userId <> :${p}Me AND ${inOrg} AND (${reach.join(' OR ')}))`,
            parameters,
        };
    }

    // `organization`: every readable row, own rows included.
    if (context.isOrganizationMember) {
        parameters[`${p}OrgVis`] = 'organization';
        reach.push(`${a}.visibility = :${p}OrgVis`);
    }
    if (reach.length === 0) return { clause: owner, parameters };
    return {
        clause: `(${owner} OR (${inOrg} AND (${reach.join(' OR ')})))`,
        parameters,
    };
}
