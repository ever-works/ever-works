import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository, type SelectQueryBuilder, type ObjectLiteral } from 'typeorm';
import {
    normalizeRecordListView,
    type RecordListView,
    type VisibilityAggregate,
} from '@ever-works/contracts';
import { Agent } from '../entities/agent.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { Organization } from '../entities/organization.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Task } from '../entities/task.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { Tenant } from '../entities/tenant.entity';
import { Work } from '../entities/work.entity';
import { WorkMember } from '../entities/work-member.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { ownershipSqlPredicate, type OwnershipScope } from '../database/ownership-scope';
import {
    buildCaseInsensitiveLikeClause,
    prepareCaseInsensitiveContainsPattern,
} from '../database/utils';
import type { RecordAccessContext, VisibilityPrincipal } from './record-access.types';
import { visibleToPredicate } from './visible-to';

/** The task participant kinds (spec §3.1). */
export type TaskParticipantKind = 'assignee' | 'approver' | 'reviewer' | 'watcher';

export const ALL_TASK_PARTICIPANT_KINDS: readonly TaskParticipantKind[] = [
    'assignee',
    'approver',
    'reviewer',
    'watcher',
];

/**
 * `RecordAccessPolicy` — who may read, comment on and transition a task, goal,
 * mission, idea or agent (EW-P1-3, `docs/specs/features/record-visibility/spec.md`
 * §3–§4). Ownership is unchanged: owners keep every right they have today, and the
 * `mine` view is exactly today's list. Visibility only ADDS readers.
 *
 * Read: {@link contextFor} resolves the caller's roster, Teams and Works once per
 * request, and {@link applyVisibleTo} composes `visibleTo(principal)` into a query.
 *
 * Write (spec §4): writes stay with the owner and the existing role rules;
 * participants (assignee, approver, reviewer) may transition a task; anyone who can
 * read a task may comment on it.
 */
@Injectable()
export class RecordAccessPolicy {
    constructor(
        @InjectRepository(OrganizationMember)
        private readonly members: Repository<OrganizationMember>,
        @InjectRepository(Organization)
        private readonly organizations: Repository<Organization>,
        @InjectRepository(Tenant)
        private readonly tenants: Repository<Tenant>,
        @InjectRepository(TeamMember)
        private readonly teamMembers: Repository<TeamMember>,
        @InjectRepository(Team)
        private readonly teams: Repository<Team>,
        @InjectRepository(WorkMember)
        private readonly workMembers: Repository<WorkMember>,
        @InjectRepository(Work)
        private readonly works: Repository<Work>,
        @InjectRepository(TaskAssignee)
        private readonly assignees: Repository<TaskAssignee>,
        @InjectRepository(TaskApprover)
        private readonly approvers: Repository<TaskApprover>,
        @InjectRepository(TaskReviewer)
        private readonly reviewers: Repository<TaskReviewer>,
        @InjectRepository(TaskWatcher)
        private readonly watchers: Repository<TaskWatcher>,
        @InjectRepository(Task)
        private readonly taskRows: Repository<Task>,
        @InjectRepository(Goal)
        private readonly goalRows: Repository<Goal>,
        @InjectRepository(Mission)
        private readonly missionRows: Repository<Mission>,
        @InjectRepository(WorkProposal)
        private readonly ideaRows: Repository<WorkProposal>,
        @InjectRepository(Agent)
        private readonly agentRows: Repository<Agent>,
    ) {}

    /** The table of an aggregate. */
    repositoryFor(aggregate: VisibilityAggregate): Repository<ObjectLiteral> {
        switch (aggregate) {
            case 'task':
                return this.taskRows as unknown as Repository<ObjectLiteral>;
            case 'goal':
                return this.goalRows as unknown as Repository<ObjectLiteral>;
            case 'mission':
                return this.missionRows as unknown as Repository<ObjectLiteral>;
            case 'idea':
                return this.ideaRows as unknown as Repository<ObjectLiteral>;
            case 'agent':
                return this.agentRows as unknown as Repository<ObjectLiteral>;
        }
    }

    /**
     * `contextFor` answers, memoized per (user, organization) for a moment: a board
     * reads every column through the list path, and each column would otherwise run
     * the roster / Team / Work lookups again. Short enough that a membership change is
     * visible on the next request.
     */
    private readonly contextMemo = new Map<
        string,
        { at: number; value: Promise<RecordAccessContext> }
    >();
    private static readonly CONTEXT_MEMO_MS = 2_000;

    /** Normalize a `?view=` query value; unknown or missing = `mine`. */
    static view(value?: string | null): RecordListView {
        return normalizeRecordListView(value);
    }

    /**
     * Resolve everything the read predicate needs for one request.
     *
     * Personal scope (`organizationId` null) needs nothing: personal rows are always
     * `private`, so reads there stay owner-only.
     */
    async contextFor(
        principal: VisibilityPrincipal,
        scope?: OwnershipScope | null,
    ): Promise<RecordAccessContext> {
        const organizationId = scope?.organizationId ?? null;
        const base: RecordAccessContext = {
            principal,
            organizationId,
            isOrganizationMember: false,
            teamIds: [],
            workIds: [],
        };
        if (principal.kind !== 'user' || !organizationId) return base;

        const key = `${principal.userId}:${organizationId}`;
        const now = Date.now();
        const memo = this.contextMemo.get(key);
        if (memo && now - memo.at < RecordAccessPolicy.CONTEXT_MEMO_MS) return memo.value;
        const value = this.resolveUserContext(base, principal.userId, organizationId);
        this.contextMemo.set(key, { at: now, value });
        value.catch(() => this.contextMemo.delete(key));
        if (this.contextMemo.size > 500) {
            for (const [entryKey, entry] of this.contextMemo) {
                if (now - entry.at >= RecordAccessPolicy.CONTEXT_MEMO_MS) {
                    this.contextMemo.delete(entryKey);
                }
            }
        }
        return value;
    }

    private async resolveUserContext(
        base: RecordAccessContext,
        userId: string,
        organizationId: string,
    ): Promise<RecordAccessContext> {
        const principal = { kind: 'user' as const, userId };
        const [isOrganizationMember, teamIds, workIds] = await Promise.all([
            this.isOrganizationMember(organizationId, principal.userId),
            this.teamIdsFor(organizationId, principal.userId),
            this.workIdsFor(principal.userId),
        ]);
        return { ...base, isOrganizationMember, teamIds, workIds };
    }

    /**
     * The authoritative Organization roster (spec §6): a roster row, or the Tenant
     * owner (a member of every Organization of their Tenant by construction — no row is
     * ever written for them). Also the act-as check for integration writes (EW-P1-2).
     */
    async isOrganizationMember(organizationId: string, userId: string): Promise<boolean> {
        const row = await this.members.findOne({
            where: { organizationId, userId },
            select: { id: true },
        });
        if (row) return true;
        const organization = await this.organizations.findOne({
            where: { id: organizationId },
            select: { id: true, tenantId: true },
        });
        if (!organization?.tenantId) return false;
        const tenant = await this.tenants.findOne({
            where: { id: organization.tenantId },
            select: { id: true, ownerUserId: true },
        });
        return tenant?.ownerUserId === userId;
    }

    /** The Organization's Teams the user is a member of. */
    async teamIdsFor(organizationId: string, userId: string): Promise<string[]> {
        const memberships = await this.teamMembers.find({
            where: { memberType: 'user', memberId: userId },
            select: { id: true, teamId: true },
        });
        if (memberships.length === 0) return [];
        const teams = await this.teams.find({
            where: { id: In([...new Set(memberships.map((m) => m.teamId))]), organizationId },
            select: { id: true },
        });
        return teams.map((team) => team.id);
    }

    /** Works the user owns or is a member of. */
    async workIdsFor(userId: string): Promise<string[]> {
        const [owned, memberOf] = await Promise.all([
            this.works.find({ where: { userId }, select: { id: true } }),
            this.workMembers.find({ where: { userId }, select: { id: true, workId: true } }),
        ]);
        return [...new Set([...owned.map((w) => w.id), ...memberOf.map((m) => m.workId)])];
    }

    /** Compose `visibleTo(principal)` into a query builder whose alias is `alias`. */
    applyVisibleTo<T extends ObjectLiteral>(
        qb: SelectQueryBuilder<T>,
        alias: string,
        aggregate: VisibilityAggregate,
        context: RecordAccessContext,
        view: RecordListView,
        parameterPrefix?: string,
    ): SelectQueryBuilder<T> {
        const predicate = visibleToPredicate({
            alias,
            aggregate,
            context,
            view,
            escape: (identifier) => qb.connection.driver.escape(identifier),
            parameterPrefix,
        });
        return qb.andWhere(predicate.clause, predicate.parameters);
    }

    /**
     * A list through `visibleTo(principal)` in the active scope — the shared / org tabs
     * of goals, missions, ideas and agents. `refine` adds the caller's own filters; the
     * order is the caller's (default `updatedAt DESC`), always ending on `id ASC` so
     * offset pages never overlap.
     */
    async listVisible<T extends ObjectLiteral>(input: {
        aggregate: VisibilityAggregate;
        userId: string;
        scope?: OwnershipScope | null;
        view: RecordListView;
        refine?: (qb: SelectQueryBuilder<T>, alias: string) => void;
        /**
         * Free-text search over these columns, case-insensitive with LIKE wildcards
         * escaped — the same rule as the owner lists, so switching tabs never turns a
         * literal `%` / `_` into a wildcard.
         */
        search?: { term?: string; columns: readonly string[] };
        orderBy?: { column: string; direction: 'ASC' | 'DESC' };
        take?: number;
        skip?: number;
    }): Promise<{ rows: T[]; total: number }> {
        const alias = 'rec';
        const qb = await this.visibleQuery<T>(
            this.repositoryFor(input.aggregate) as unknown as Repository<T>,
            alias,
            input.aggregate,
            input.userId,
            input.scope,
            input.view,
        );
        input.refine?.(qb, alias);
        const pattern = prepareCaseInsensitiveContainsPattern(input.search?.term);
        if (pattern && input.search && input.search.columns.length > 0) {
            qb.andWhere(
                `(${input.search.columns
                    .map((column) =>
                        buildCaseInsensitiveLikeClause(`${alias}.${column}`, 'visSearch'),
                    )
                    .join(' OR ')})`,
                { visSearch: pattern },
            );
        }
        const total = await qb.getCount();
        const order = input.orderBy ?? { column: 'updatedAt', direction: 'DESC' as const };
        qb.orderBy(`${alias}.${order.column}`, order.direction).addOrderBy(`${alias}.id`, 'ASC');
        if (input.take !== undefined) qb.take(input.take);
        if (input.skip !== undefined) qb.skip(input.skip);
        return { rows: await qb.getMany(), total };
    }

    /**
     * One row by id that the user may READ but does not own (the get-by-id fallback
     * after the owner lookup 404s). `null` → the caller answers 404, so existence
     * never leaks. Personal scope always answers `null`.
     */
    async findVisibleNotOwned<T extends ObjectLiteral>(input: {
        aggregate: VisibilityAggregate;
        userId: string;
        id: string;
        scope?: OwnershipScope | null;
    }): Promise<T | null> {
        if (!input.scope?.organizationId) return null;
        const alias = 'rec';
        const qb = await this.visibleQuery<T>(
            this.repositoryFor(input.aggregate) as unknown as Repository<T>,
            alias,
            input.aggregate,
            input.userId,
            input.scope,
            'shared-or-org',
        );
        qb.andWhere(`${alias}.id = :visRecordId`, { visRecordId: input.id });
        qb.andWhere(`${alias}.userId <> :visNotOwner`, { visNotOwner: input.userId });
        return qb.getOne();
    }

    private async visibleQuery<T extends ObjectLiteral>(
        repository: Repository<T>,
        alias: string,
        aggregate: VisibilityAggregate,
        userId: string,
        scope: OwnershipScope | null | undefined,
        view: RecordListView | 'shared-or-org',
    ): Promise<SelectQueryBuilder<T>> {
        const context = await this.contextFor({ kind: 'user', userId }, scope);
        const qb = repository.createQueryBuilder(alias);
        const predicate = visibleToPredicate({
            alias,
            aggregate,
            context,
            view: view === 'shared-or-org' ? 'organization' : view,
            escape: (identifier) => qb.connection.driver.escape(identifier),
        });
        qb.where(predicate.clause, predicate.parameters);
        const scopePredicate = ownershipSqlPredicate(alias, scope ?? undefined, 'visScope');
        if (scopePredicate) qb.andWhere(scopePredicate.clause, scopePredicate.parameters);
        return qb;
    }

    /** Whether the user takes part in the task as one of `kinds`. */
    async isTaskParticipant(
        taskId: string,
        userId: string,
        kinds: readonly TaskParticipantKind[] = ALL_TASK_PARTICIPANT_KINDS,
    ): Promise<boolean> {
        const checks: Array<Promise<number>> = [];
        if (kinds.includes('assignee')) {
            checks.push(
                this.assignees.count({
                    where: { taskId, assigneeType: 'user', assigneeId: userId },
                }),
            );
        }
        if (kinds.includes('approver')) {
            checks.push(
                this.approvers.count({
                    where: { taskId, approverType: 'user', approverId: userId },
                }),
            );
        }
        if (kinds.includes('reviewer')) {
            checks.push(
                this.reviewers.count({
                    where: { taskId, reviewerType: 'user', reviewerId: userId },
                }),
            );
        }
        if (kinds.includes('watcher')) {
            checks.push(this.watchers.count({ where: { taskId, userId } }));
        }
        const counts = await Promise.all(checks);
        return counts.some((count) => count > 0);
    }
}
