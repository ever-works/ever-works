import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, type EntityManager, type EntityTarget, type ObjectLiteral } from 'typeorm';
import {
    automaticRecordVisibility,
    isRecordVisibility,
    type RecordVisibility,
    type VisibilityAggregate,
} from '@ever-works/contracts';
import { Agent } from '../entities/agent.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { Task } from '../entities/task.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { DomainEventRecorder } from '../domain-events/domain-event-recorder.service';
import { assertExpectedAggregateVersion } from '../domain-events/domain-event-context';
import {
    type AggregateSnapshot,
    buildAgentSnapshot,
    buildGoalSnapshot,
    buildIdeaSnapshot,
    buildMissionSnapshot,
    buildTaskSnapshot,
    buildTeamSnapshot,
} from '../domain-events/domain-event-snapshots';
import { VISIBILITY_AGGREGATE_SHAPES } from './record-access.types';
import { serializeOnSingleConnection } from '../database/repositories/single-connection-write-queue';

/** A hand-picked visibility, or `automatic` to hand the choice back to D11. */
export type VisibilityChoice = RecordVisibility | 'automatic';

export const VISIBILITY_CHOICES: readonly VisibilityChoice[] = [
    'automatic',
    'private',
    'team',
    'organization',
];

export function isVisibilityChoice(value: unknown): value is VisibilityChoice {
    return value === 'automatic' || isRecordVisibility(value);
}

/** The row columns this service reads and writes. */
interface VisibilityRecord {
    id: string;
    userId: string;
    tenantId?: string | null;
    organizationId?: string | null;
    visibility: RecordVisibility;
    visibilityExplicit: boolean;
    teamId?: string | null;
    /** Tasks only: the sub-task hierarchy `setTeams` must keep consistent. */
    parentTaskId?: string | null;
}

/** The `team_resources` rows a {@link RecordVisibilityService.setTeamsIn} call added and removed. */
export interface TeamSideChange {
    readonly resourceType: TeamResource['resourceType'];
    readonly resourceId: string;
    /** Teams that gained the record. */
    readonly added: readonly string[];
    /** Teams that lost it. */
    readonly removed: readonly string[];
    /** A private record: its Teams' events stay off the feed. */
    readonly isPrivate: boolean;
}

export interface VisibilityState {
    visibility: RecordVisibility;
    visibilityExplicit: boolean;
    /** The record's Teams: `teamId` (tasks) first, then `team_resources` / agent memberships. */
    teamIds: string[];
}

/** A Team the record could sit on (its Organization's Teams), for the form's picker. */
export interface OrganizationTeamOption {
    id: string;
    name: string;
    slug: string;
}

const ENTITY_OF: Record<VisibilityAggregate, EntityTarget<ObjectLiteral>> = {
    task: Task,
    goal: Goal,
    mission: Mission,
    idea: WorkProposal,
    agent: Agent,
};

/**
 * Aggregates whose `visibility_changed` (and Teams `<aggregate>.updated`) is recorded
 * today, with their integration snapshot: the P1 aggregates that carry a `version`
 * column (EW-P1-1), then the P2 ones as their recording points land (ideas: EW-P2-1,
 * goals: EW-P2-2, missions: EW-P2-5). Every visibility aggregate records now (see {@link RecordVisibilityService.recordChange}).
 */
const SNAPSHOT_OF: Partial<
    Record<
        VisibilityAggregate,
        (manager: EntityManager, id: string) => Promise<AggregateSnapshot<object> | null>
    >
> = {
    task: buildTaskSnapshot,
    agent: buildAgentSnapshot,
    idea: buildIdeaSnapshot,
    goal: buildGoalSnapshot,
    mission: buildMissionSnapshot,
};

/** Thrown for an integration write of `private` (contract: `422 domain_rule`). */
export class PrivateVisibilityForbiddenError extends UnprocessableEntityException {
    constructor() {
        super({
            error: {
                code: 'domain_rule',
                message:
                    'An integration may set team or organization only: a private record would disappear from its own view.',
                details: { field: 'visibility' },
            },
        });
    }
}

/**
 * Record visibility writes (EW-P1-3, `docs/specs/features/record-visibility/spec.md` §5):
 *
 *   - **By hand** ({@link setVisibility}): the owner picks `private` / `team` /
 *     `organization` (sets `visibilityExplicit`) or `automatic` (clears it and applies
 *     D11 again).
 *   - **Automatic** ({@link recomputeAutomatic}): while `visibilityExplicit` is false, an
 *     org row's first Team narrows `organization` → `team` and its last Team leaving
 *     widens `team` → `organization`. A hand-picked value never changes on its own, and
 *     `private` is only ever set by hand.
 *   - **Integration** ({@link assertIntegrationVisibility}, {@link setTeams}): `team` /
 *     `organization` only (`422 domain_rule` for `private`); `teamIds[]` is stored as
 *     `teamId` (first, tasks) plus `team_resources` (the rest).
 *
 * Every change records `<aggregate>.visibility_changed` through the domain-event
 * recorder in the same transaction (tasks, agents and ideas today). A change TO `private`
 * carries only `{id, visibility:'private'}`.
 *
 * Callers authorize first: only the owner (and the existing role rules) may change a
 * record's visibility.
 */
@Injectable()
export class RecordVisibilityService {
    private readonly logger = new Logger(RecordVisibilityService.name);

    /**
     * A transaction queued with every other queued writer of this DataSource on a
     * single-connection driver (better-sqlite3), run at once on Postgres. The work must
     * never queue again on the same DataSource (it would wait on itself): everything
     * inside goes through the given `manager`.
     */
    private inQueuedTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
        return serializeOnSingleConnection(this.dataSource.manager, () =>
            this.dataSource.transaction(work),
        );
    }

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @Optional() private readonly recorder?: DomainEventRecorder,
    ) {}

    /** The record's visibility, explicit flag and Teams (`null` when missing). */
    async getState(aggregate: VisibilityAggregate, id: string): Promise<VisibilityState | null> {
        const row = await this.load(this.dataSource.manager, aggregate, id);
        if (!row) return null;
        return {
            visibility: row.visibility,
            visibilityExplicit: row.visibilityExplicit,
            teamIds: await this.teamIdsOf(this.dataSource.manager, aggregate, row),
        };
    }

    /**
     * The owner chooses a visibility by hand, or `automatic`. A personal-scope record
     * has no Organization to share with: it only takes `private` / `automatic`.
     */
    async setVisibility(
        aggregate: VisibilityAggregate,
        id: string,
        choice: VisibilityChoice,
    ): Promise<VisibilityState | null> {
        if (!isVisibilityChoice(choice)) {
            throw new BadRequestException(
                `visibility must be one of: ${VISIBILITY_CHOICES.join(', ')}`,
            );
        }
        // Queued on single-connection drivers (better-sqlite3): every caller shares ONE
        // query runner there, so an unqueued transaction overlapping a queued one (the
        // domain-event publisher's) nests as its savepoint and fails on commit ("no such
        // savepoint" / "cannot start a transaction within a transaction"). Postgres runs
        // it immediately, unchanged.
        return this.inQueuedTransaction(async (manager) => {
            const row = await this.load(manager, aggregate, id);
            if (!row) return null;
            if (!row.organizationId && choice !== 'private' && choice !== 'automatic') {
                throw new BadRequestException(
                    'A personal record cannot be shared: move it into an Organization first.',
                );
            }
            const teamIds = await this.teamIdsOf(manager, aggregate, row);
            const next =
                choice === 'automatic'
                    ? {
                          visibility: automaticRecordVisibility({
                              organizationId: row.organizationId,
                              hasTeam: teamIds.length > 0,
                          }),
                          visibilityExplicit: false,
                      }
                    : { visibility: choice, visibilityExplicit: true };
            await this.apply(manager, aggregate, row, next, teamIds);
            return { ...next, teamIds };
        });
    }

    /**
     * Re-apply D11 after a Team change (a Team attached or detached, a task's `teamId`
     * set or cleared, an agent added to or removed from a Team, a Team deleted). A no-op
     * for a hand-picked visibility and for a personal record. Never throws: a missed
     * automatic change must not fail the Team write that triggered it.
     */
    async recomputeAutomatic(aggregate: VisibilityAggregate, id: string): Promise<void> {
        try {
            await this.inQueuedTransaction((manager) =>
                this.recomputeAutomaticIn(manager, aggregate, id),
            );
        } catch (error) {
            this.logger.warn(
                `Automatic visibility for ${aggregate} ${id} failed: ${(error as Error).message}`,
            );
        }
    }

    /**
     * {@link recomputeAutomatic} inside the caller's transaction, BEFORE it records its
     * own snapshot event (`task.updated`, `agent.updated` with `teamIds` changed), so
     * that event already carries the new visibility. Pass `recordEvent: false` there:
     * the caller's full-snapshot event is the change notice, and an automatic change is
     * never to or from `private`. Answers whether the visibility changed.
     */
    async recomputeAutomaticIn(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        id: string,
        options: { recordEvent?: boolean } = {},
    ): Promise<boolean> {
        const row = await this.load(manager, aggregate, id);
        if (!row || row.visibilityExplicit || !row.organizationId) return false;
        const teamIds = await this.teamIdsOf(manager, aggregate, row);
        const visibility = automaticRecordVisibility({
            organizationId: row.organizationId,
            hasTeam: teamIds.length > 0,
        });
        if (visibility === row.visibility) return false;
        return this.apply(
            manager,
            aggregate,
            row,
            { visibility, visibilityExplicit: false },
            teamIds,
            options.recordEvent ?? true,
            true,
        );
    }

    /**
     * The Teams of the record's Organization, for the form's Team picker. Empty for a
     * personal record (it cannot sit on a Team). Teams are visible org-wide already.
     */
    async organizationTeamsOf(
        aggregate: VisibilityAggregate,
        id: string,
    ): Promise<OrganizationTeamOption[]> {
        const row = await this.load(this.dataSource.manager, aggregate, id);
        if (!row?.organizationId) return [];
        const teams = await this.dataSource.manager.getRepository(Team).find({
            where: { organizationId: row.organizationId },
            select: { id: true, name: true, slug: true },
            order: { name: 'ASC' },
        });
        return teams.map((team) => ({ id: team.id, name: team.name, slug: team.slug }));
    }

    /** {@link recomputeAutomatic} for every record of a Team (before it is deleted). */
    async recordsOfTeam(
        teamId: string,
    ): Promise<Array<{ aggregate: VisibilityAggregate; id: string }>> {
        const manager = this.dataSource.manager;
        const out: Array<{ aggregate: VisibilityAggregate; id: string }> = [];
        const resources = await manager.getRepository(TeamResource).find({ where: { teamId } });
        for (const resource of resources) {
            const aggregate = this.aggregateOfResourceType(resource.resourceType);
            if (aggregate) out.push({ aggregate, id: resource.resourceId });
        }
        const tasks = await manager
            .getRepository(Task)
            .find({ where: { teamId }, select: { id: true } });
        out.push(...tasks.map((task) => ({ aggregate: 'task' as const, id: task.id })));
        const agents = await manager
            .getRepository(TeamMember)
            .find({ where: { teamId, memberType: 'agent' } });
        out.push(...agents.map((member) => ({ aggregate: 'agent' as const, id: member.memberId })));
        return out;
    }

    /** Integration writes may set `team` or `organization` only (contract B.1). */
    static assertIntegrationVisibility(value: unknown): asserts value is 'team' | 'organization' {
        if (value === 'private') throw new PrivateVisibilityForbiddenError();
        if (value !== 'team' && value !== 'organization') {
            throw new BadRequestException('visibility must be team or organization');
        }
    }

    /**
     * Replace a record's Teams with `teamIds` (integration `teamIds[]`, the goal form):
     * for a task the first id is `teamId` and the rest are `team_resources`; for the
     * other aggregates every id is a `team_resources` row (agents: `team_members` stay
     * the Teams' own business and are left alone). Every Team must belong to the record's
     * Organization (404 otherwise). Then D11 is re-applied.
     */
    async setTeams(
        aggregate: VisibilityAggregate,
        id: string,
        teamIds: readonly string[],
        addedById: string | null,
    ): Promise<VisibilityState | null> {
        const state = await this.inQueuedTransaction(async (manager) => {
            const result = await this.setTeamsIn(manager, aggregate, id, teamIds, addedById);
            if (!result) return null;
            // D11 in the same transaction: a scope move records `visibility_changed`
            // (whose DTO carries the new `teamIds`); a Teams change that keeps the
            // scope records `<aggregate>.updated` with `changedFields: ['teamIds']`.
            const moved = await this.recomputeAutomaticIn(manager, aggregate, id);
            if (!moved && result.changed) {
                await this.recordTeamsChanged(manager, aggregate, id, result.previousTeamIds);
            }
            await this.recordTeamSideIn(manager, result.teamSide);
            return result;
        });
        if (!state) return null;
        return this.getState(aggregate, id);
    }

    /**
     * {@link setTeams} inside the caller's transaction, without D11 or any event of the
     * record (a create path applies both after: `recomputeAutomaticIn` then its
     * `<aggregate>.created`, then {@link recordTeamSideIn} with `teamSide`, F34). Answers
     * the Teams before and after, `null` when the record is missing.
     */
    async setTeamsIn(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        id: string,
        teamIds: readonly string[],
        addedById: string | null,
    ): Promise<{
        previousTeamIds: string[];
        teamIds: string[];
        changed: boolean;
        teamSide: TeamSideChange;
    } | null> {
        const unique = [...new Set(teamIds)];
        const row = await this.load(manager, aggregate, id);
        if (!row) return null;
        const previousTeamIds = await this.teamIdsOf(manager, aggregate, row);
        if (unique.length > 0) {
            if (!row.organizationId) {
                throw new BadRequestException(
                    'A personal record cannot sit on a Team: move it into an Organization first.',
                );
            }
            const teams = await manager.getRepository(Team).find({
                where: { id: In(unique), organizationId: row.organizationId },
                select: { id: true },
            });
            if (teams.length !== unique.length) {
                // 404-not-403: a foreign and a missing Team read the same.
                throw new NotFoundException('Team not found');
            }
        }
        const shape = VISIBILITY_AGGREGATE_SHAPES[aggregate];
        let resourceTeamIds = unique;
        if (shape.teamColumn) {
            const first = unique[0] ?? null;
            if ((row.teamId ?? null) !== first) {
                await this.assertTaskTreeAllowsTeam(manager, row, first);
            }
            await manager
                .getRepository(ENTITY_OF[aggregate])
                .update({ id }, { [shape.teamColumn]: first });
            row.teamId = first;
            resourceTeamIds = unique.slice(1);
        }
        const resources = manager.getRepository(TeamResource);
        const existing = await resources.find({
            where: {
                resourceType: shape.teamResourceType as TeamResource['resourceType'],
                resourceId: id,
            },
        });
        const keep = new Set(resourceTeamIds);
        const stale = existing.filter((resource) => !keep.has(resource.teamId));
        if (stale.length > 0) {
            await resources.delete({ id: In(stale.map((resource) => resource.id)) });
        }
        const present = new Set(existing.map((resource) => resource.teamId));
        const added: string[] = [];
        for (const teamId of resourceTeamIds) {
            if (present.has(teamId)) continue;
            await resources.save(
                resources.create({
                    teamId,
                    resourceType: shape.teamResourceType as TeamResource['resourceType'],
                    resourceId: id,
                    addedById,
                    tenantId: row.tenantId ?? null,
                    organizationId: row.organizationId ?? null,
                    createdAt: new Date(),
                }),
            );
            added.push(teamId);
        }
        const next = await this.teamIdsOf(manager, aggregate, row);
        const before = new Set(previousTeamIds);
        const changed = next.length !== before.size || next.some((teamId) => !before.has(teamId));
        const teamSide: TeamSideChange = {
            resourceType: shape.teamResourceType as TeamResource['resourceType'],
            resourceId: id,
            added,
            removed: stale.map((resource) => resource.teamId),
            isPrivate: row.visibility === 'private',
        };
        return { previousTeamIds, teamIds: next, changed, teamSide };
    }

    /**
     * Review 2026-10-17 F34: the Teams' side of a {@link setTeamsIn} change, as
     * `TeamResourcesService.attach` / `detach` record it: each Team whose resources moved
     * gets `team.resource.added` / `removed` and a version bump, so its integration copy
     * (and ETag) follows. {@link setTeams} calls it after the record's own event; a create
     * path calls it after its `<aggregate>.created`, so a consumer never meets a Team
     * resource before the record. A private record's link stays off the feed (F4).
     */
    async recordTeamSideIn(manager: EntityManager, change: TeamSideChange): Promise<void> {
        const ref = { resourceType: change.resourceType, resourceId: change.resourceId };
        for (const teamId of change.removed) {
            await this.recordTeamResourceChange(
                manager,
                teamId,
                'team.resource.removed',
                { teamId, ...ref, deleted: true },
                change.isPrivate,
            );
        }
        for (const teamId of change.added) {
            await this.recordTeamResourceChange(
                manager,
                teamId,
                'team.resource.added',
                { teamId, ...ref },
                change.isPrivate,
            );
        }
    }

    // ── internals ─────────────────────────────────────────────────────

    /**
     * The rule `TasksService.update` applies to a Task's owners: a sub-task agrees with
     * its parent on every owner (`teamId` included), and a parent with sub-tasks cannot
     * change owners without stranding them. `teamId` is the only owner `setTeams` moves.
     */
    private async assertTaskTreeAllowsTeam(
        manager: EntityManager,
        row: VisibilityRecord,
        teamId: string | null,
    ): Promise<void> {
        const tasks = manager.getRepository(Task);
        if (row.parentTaskId) {
            const parent = await tasks.findOne({
                where: { id: row.parentTaskId },
                select: { id: true, teamId: true },
            });
            if (parent && (parent.teamId ?? null) !== teamId) {
                throw new BadRequestException(
                    "A sub-task's first Team must match its parent Task's Team: change the parent's Teams, or detach the sub-task first.",
                );
            }
        }
        const children = await tasks.count({ where: { parentTaskId: row.id } });
        if (children > 0) {
            throw new BadRequestException(
                `This Task has ${children} sub-task(s); re-file or detach them before changing its first Team so parent and child scopes cannot diverge.`,
            );
        }
    }

    private async load(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        id: string,
    ): Promise<VisibilityRecord | null> {
        const row = await manager.getRepository(ENTITY_OF[aggregate]).findOne({ where: { id } });
        return (row as VisibilityRecord | null) ?? null;
    }

    /** `teamId` (tasks) first, then the `team_resources` rows, then agent memberships. */
    private async teamIdsOf(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        row: VisibilityRecord,
    ): Promise<string[]> {
        const shape = VISIBILITY_AGGREGATE_SHAPES[aggregate];
        const ids: string[] = [];
        if (shape.teamColumn && row.teamId) ids.push(row.teamId);
        const resources = await manager.getRepository(TeamResource).find({
            where: {
                resourceType: shape.teamResourceType as TeamResource['resourceType'],
                resourceId: row.id,
            },
            order: { createdAt: 'ASC' },
        });
        ids.push(...resources.map((resource) => resource.teamId));
        if (shape.teamMemberType) {
            const memberships = await manager.getRepository(TeamMember).find({
                where: {
                    memberType: shape.teamMemberType as TeamMember['memberType'],
                    memberId: row.id,
                },
            });
            ids.push(...memberships.map((member) => member.teamId));
        }
        return [...new Set(ids)];
    }

    /**
     * Write the new visibility (and record its event). `automatic` makes the write a
     * compare-and-set on the state this change was computed from (`visibilityExplicit
     * = false` and the old `visibility`): an owner's concurrent choice by hand — say
     * `private` — always wins, and the automatic change then records nothing.
     * Answers whether the row changed.
     */
    private async apply(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        row: VisibilityRecord,
        next: { visibility: RecordVisibility; visibilityExplicit: boolean },
        teamIds: string[],
        recordEvent = true,
        automatic = false,
    ): Promise<boolean> {
        if (
            next.visibility === row.visibility &&
            next.visibilityExplicit === row.visibilityExplicit
        ) {
            return false;
        }
        const criteria: Record<string, unknown> = automatic
            ? { id: row.id, visibilityExplicit: false, visibility: row.visibility }
            : { id: row.id };
        const result = await manager.getRepository(ENTITY_OF[aggregate]).update(criteria, {
            visibility: next.visibility,
            visibilityExplicit: next.visibilityExplicit,
        });
        if (automatic && result.affected === 0) return false;
        if (recordEvent && next.visibility !== row.visibility) {
            await this.recordChange(manager, aggregate, row, next, teamIds);
        } else if (recordEvent) {
            // Review 2026-10-17 F35: only `visibilityExplicit` moved (a value picked by hand
            // that equals the automatic one, or back to automatic). The DTO carries the flag,
            // so the version moves and the change is on the feed too.
            await this.recordExplicitChanged(manager, aggregate, row, next);
        }
        return true;
    }

    /** `<aggregate>.updated` with `changedFields: ['visibilityExplicit']` (F35). */
    private async recordExplicitChanged(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        row: VisibilityRecord,
        next: { visibility: RecordVisibility; visibilityExplicit: boolean },
    ): Promise<void> {
        const build = SNAPSHOT_OF[aggregate];
        if (!this.recorder || !build || !row.organizationId) return;
        const version = await this.recorder.bumpAggregateVersion(manager, aggregate, row.id);
        assertExpectedAggregateVersion(aggregate, row.id, version);
        const snapshot = await build(manager, row.id);
        if (!snapshot?.organizationId) return;
        await this.recorder.record(manager, {
            type: `${aggregate}.updated`,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: aggregate, id: row.id, version },
            data: snapshot.dto as Record<string, unknown>,
            changedFields: ['visibilityExplicit'],
            previous: { visibilityExplicit: row.visibilityExplicit === true },
            visibility: next.visibility,
        });
    }

    /**
     * A Team's `team.resource.added` / `removed` for a record whose Teams moved here
     * (F34): bumps the Team's version, as `DomainEventPublisher.child` does. A private
     * record's link stays off the feed (F4).
     */
    private async recordTeamResourceChange(
        manager: EntityManager,
        teamId: string,
        type: 'team.resource.added' | 'team.resource.removed',
        data: Record<string, unknown>,
        isPrivate: boolean,
    ): Promise<void> {
        if (!this.recorder) return;
        const version = await this.recorder.bumpAggregateVersion(manager, 'team', teamId);
        assertExpectedAggregateVersion('team', teamId, version);
        const snapshot = await buildTeamSnapshot(manager, teamId);
        if (!snapshot?.organizationId) return;
        await this.recorder.record(manager, {
            type,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: 'team', id: teamId, version },
            data,
            changedFields: ['resources'],
            visibility: isPrivate ? 'private' : snapshot.dto.visibility,
        });
    }

    /**
     * `<aggregate>.visibility_changed` (contract B.4). To `private`: `{id, visibility}`
     * only, so consumers stop syncing without seeing the content. To `team` /
     * `organization`: the full integration DTO (B2 snapshot builders, read through the
     * same transaction, so it already carries the new visibility).
     *
     * Ideas record since EW-P2-1; goals and missions join with their P2 recording
     * points (add their builder to `SNAPSHOT_OF`).
     */
    private async recordChange(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        row: VisibilityRecord,
        next: { visibility: RecordVisibility; visibilityExplicit: boolean },
        teamIds: string[],
    ): Promise<void> {
        const build = SNAPSHOT_OF[aggregate];
        if (!this.recorder || !build || !row.organizationId) return;
        const aggregateType = aggregate;
        const version = await this.recorder.bumpAggregateVersion(manager, aggregateType, row.id);
        // An integration write under `If-Match` (runExpectingAggregateVersion) is refused
        // here, in the change's transaction, when a concurrent write bumped first.
        assertExpectedAggregateVersion(aggregateType, row.id, version);
        let data: Record<string, unknown>;
        if (next.visibility === 'private') {
            data = { id: row.id, visibility: 'private' };
        } else {
            const snapshot = await build(manager, row.id);
            data = snapshot
                ? (snapshot.dto as unknown as Record<string, unknown>)
                : {
                      id: row.id,
                      organizationId: row.organizationId,
                      visibility: next.visibility,
                      visibilityExplicit: next.visibilityExplicit,
                      version,
                      teamIds,
                  };
        }
        await this.recorder.record(manager, {
            type: `${aggregate}.visibility_changed`,
            tenantId: row.tenantId ?? null,
            organizationId: row.organizationId,
            aggregate: { type: aggregateType, id: row.id, version },
            data,
            changedFields: ['visibility'],
            previous: { visibility: row.visibility },
            visibility: next.visibility,
        });
    }

    /**
     * `<aggregate>.updated` for a Teams change that kept the scope (`changedFields:
     * ['teamIds']`, the previous set in `previous`). The recorder stores the row's
     * visibility on the event, so a `private` record's change is never served.
     */
    private async recordTeamsChanged(
        manager: EntityManager,
        aggregate: VisibilityAggregate,
        id: string,
        previousTeamIds: string[],
    ): Promise<void> {
        const build = SNAPSHOT_OF[aggregate];
        if (!this.recorder || !build) return;
        const version = await this.recorder.bumpAggregateVersion(manager, aggregate, id);
        assertExpectedAggregateVersion(aggregate, id, version);
        const snapshot = await build(manager, id);
        if (!snapshot?.organizationId) return;
        await this.recorder.record(manager, {
            type: `${aggregate}.updated`,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: aggregate, id, version },
            data: snapshot.dto as Record<string, unknown>,
            changedFields: ['teamIds'],
            previous: { teamIds: previousTeamIds },
        });
    }

    private aggregateOfResourceType(resourceType: string): VisibilityAggregate | null {
        switch (resourceType) {
            case 'task':
                return 'task';
            case 'goal':
                return 'goal';
            case 'mission':
                return 'mission';
            case 'idea':
                return 'idea';
            case 'agent':
                return 'agent';
            default:
                return null;
        }
    }
}
