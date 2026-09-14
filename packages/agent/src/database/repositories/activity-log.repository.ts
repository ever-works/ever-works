import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type SelectQueryBuilder } from 'typeorm';
import { ActivityLog } from '../../entities/activity-log.entity';
import { buildCaseInsensitiveLikeClause, prepareCaseInsensitiveContainsPattern } from '../utils';
import { ownershipSqlPredicate, type OwnershipScope } from '../ownership-scope';
import type {
    ActivityLogQueryOptions,
    ActivityActionType,
    ActivityFeedKindFilter,
    ActivityFeedQueryOptions,
    ActivityStatus,
    CreateActivityLogDto,
} from '../../entities/activity-log.types';

/** One page of the Live Feed as the repository returns it. */
export interface ActivityFeedPageRows {
    /** Newest first; at most `limit` rows. */
    rows: ActivityLog[];
    /**
     * The exact ordering timestamp of each row, keyed by row id, for building
     * the next keyset cursor. On Postgres this keeps the column's microsecond
     * precision, which a JS `Date` would silently round away.
     */
    sortKeys: Map<string, string>;
    hasMore: boolean;
}

/** Entries attributed to one agent inside a window. */
export interface ActivityFeedActorCount {
    agentId: string;
    count: number;
    /** ISO timestamp of the newest attributed entry. */
    lastActivityAt: string | null;
}

/** The fields actor attribution reads from a row with no stamped actor agent. */
export type ActivityFeedLegacyActorRow = Pick<
    ActivityLog,
    'id' | 'actionType' | 'actorKind' | 'actorAgentId' | 'details' | 'createdAt'
>;

/** One bounded read of {@link ActivityLogRepository.findFeedLegacyActorRows}. */
export interface ActivityFeedLegacyActorQuery {
    since: Date;
    /**
     * Action types a person performs. A row of one of these with no actor
     * stamped names its agent as the subject, never the actor, so it is not
     * read at all.
     */
    personActionTypes: readonly string[];
    /** Keyset position: only rows whose id sorts after this one. */
    afterId: string | null;
    limit: number;
}

type ActivityQueryBuilder = SelectQueryBuilder<ActivityLog>;

/** Placeholder for an empty `IN (...)` list, which is not valid SQL. */
const NO_MATCH = ['__none__'];

@Injectable()
export class ActivityLogRepository {
    constructor(
        @InjectRepository(ActivityLog)
        private readonly repository: Repository<ActivityLog>,
    ) {}

    async create(
        data: CreateActivityLogDto,
        overrides?: { createdAt?: Date },
    ): Promise<ActivityLog> {
        const entry = this.repository.create({
            ...data,
            ...(overrides?.createdAt ? { createdAt: overrides.createdAt } : {}),
        });
        return this.repository.save(entry);
    }

    async update(id: string, data: Partial<ActivityLog>): Promise<ActivityLog | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    async findById(id: string): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['work'],
        });
    }

    async findByIdAndUserId(id: string, userId: string): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { id, userId },
            relations: ['work'],
        });
    }

    async findByWorkAndIngestEventId(
        workId: string,
        ingestEventId: string,
    ): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { workId, ingestEventId },
        });
    }

    /**
     * Per-Work activity-log lookup that intentionally ignores `userId`.
     *
     * The Activity Feed tab is scoped by `workId` and access is enforced
     * upstream by `WorkOwnershipService.ensureAccess` (controller layer).
     * Filtering by `userId` here would drop rows attributed to other
     * collaborators on the same Work — including the website-ingested
     * rows that EW-120 attributes to the Work owner — making them
     * invisible to members.
     */
    async findByWork(options: {
        workId: string;
        /**
         * Filter by a single action type or a set of types (issues a single
         * `IN (...)` query instead of N parallel queries). Accepting an
         * array lets the feed aggregator avoid the per-type fan-out that
         * previously multiplied the row budget.
         */
        actionType?: ActivityActionType | ActivityActionType[];
        dateTo?: Date;
        limit?: number;
        offset?: number;
    }): Promise<{ activities: ActivityLog[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('activity')
            .leftJoinAndSelect('activity.work', 'work')
            .where('activity.workId = :workId', { workId: options.workId })
            .orderBy('activity.createdAt', 'DESC');

        if (options.actionType) {
            if (Array.isArray(options.actionType)) {
                if (options.actionType.length > 0) {
                    qb.andWhere('activity.actionType IN (:...actionTypes)', {
                        actionTypes: options.actionType,
                    });
                }
            } else {
                qb.andWhere('activity.actionType = :actionType', {
                    actionType: options.actionType,
                });
            }
        }
        if (options.dateTo) {
            qb.andWhere('activity.createdAt <= :dateTo', { dateTo: options.dateTo });
        }

        const limit = Math.min(options.limit ?? 25, 100);
        const offset = options.offset ?? 0;

        const [activities, total] = await qb.take(limit).skip(offset).getManyAndCount();
        return { activities, total };
    }

    /**
     * Per-Agent lifecycle events (AGENT_PAUSED / AGENT_RESUMED / …) for
     * the /agents/[id]/activity feed. The activity log has no dedicated
     * `agentId` column — agent writers (AgentsController.tryLog) stamp
     * `details.resourceId` instead — so this matches on the serialized
     * `"resourceId":"<agentId>"` JSON fragment. `details` is a
     * `simple-json` (text) column, which makes LIKE portable across
     * postgres/sqlite; the userId + actionType predicates keep the
     * scanned set small.
     */
    async findAgentEvents(options: {
        userId: string;
        agentId: string;
        actionTypes: ActivityActionType[];
        limit?: number;
        offset?: number;
    }): Promise<{ activities: ActivityLog[]; total: number }> {
        if (options.actionTypes.length === 0) return { activities: [], total: 0 };
        const limit = Math.min(options.limit ?? 25, 100);
        const offset = options.offset ?? 0;
        // The id lands inside the LIKE pattern, where `%` / `_` are
        // wildcards — escape them (and the escape char itself) so the
        // needle only ever matches the literal id. The controller path
        // guarantees a UUID, but this is a public repository method and
        // an unvalidated id must not be able to widen the match. The
        // explicit ESCAPE keeps the behaviour portable: sqlite's LIKE
        // has no default escape character.
        const escapedAgentId = options.agentId.replace(/[\\%_]/g, '\\$&');
        const [activities, total] = await this.repository
            .createQueryBuilder('activity')
            .where('activity.userId = :userId', { userId: options.userId })
            .andWhere('activity.actionType IN (:...actionTypes)', {
                actionTypes: options.actionTypes,
            })
            .andWhere("activity.details LIKE :needle ESCAPE '\\'", {
                needle: `%"resourceId":"${escapedAgentId}"%`,
            })
            .orderBy('activity.createdAt', 'DESC')
            .take(limit)
            .skip(offset)
            .getManyAndCount();
        return { activities, total };
    }

    /**
     * Tasks upgrades — the per-Task activity feed. Task-domain writers
     * (`TasksService.logActivity`) stamp `details.resourceType='task'` +
     * `details.resourceId=<taskId>`; like {@link findAgentEvents} this
     * matches the serialized JSON fragments (portable LIKE on the
     * `simple-json` text column), scoped by userId so the scan stays
     * small and owner-bounded.
     */
    async findResourceEvents(options: {
        userId: string;
        resourceType: string;
        resourceId: string;
        limit?: number;
        offset?: number;
    }): Promise<{ activities: ActivityLog[]; total: number }> {
        const limit = Math.min(options.limit ?? 25, 100);
        const offset = options.offset ?? 0;
        // Escape LIKE wildcards in both needles (see findAgentEvents).
        const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
        const [activities, total] = await this.repository
            .createQueryBuilder('activity')
            .where('activity.userId = :userId', { userId: options.userId })
            .andWhere("activity.details LIKE :typeNeedle ESCAPE '\\'", {
                typeNeedle: `%"resourceType":"${escape(options.resourceType)}"%`,
            })
            .andWhere("activity.details LIKE :idNeedle ESCAPE '\\'", {
                idNeedle: `%"resourceId":"${escape(options.resourceId)}"%`,
            })
            .orderBy('activity.createdAt', 'DESC')
            .take(limit)
            .skip(offset)
            .getManyAndCount();
        return { activities, total };
    }

    async findLatestByUserWorkActionStatus(params: {
        userId: string;
        workId: string;
        actionType: ActivityActionType;
        status: ActivityStatus;
    }): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: {
                userId: params.userId,
                workId: params.workId,
                actionType: params.actionType,
                status: params.status,
            },
            order: { createdAt: 'DESC' },
            relations: ['work'],
        });
    }

    async findInProgressGenerationsByUserId(userId: string): Promise<ActivityLog[]> {
        return this.repository.find({
            where: {
                userId,
                actionType: 'generation' as ActivityActionType,
                status: 'in_progress' as ActivityStatus,
            },
            order: { createdAt: 'DESC' },
        });
    }

    async findByUserId(
        options: ActivityLogQueryOptions,
    ): Promise<{ activities: ActivityLog[]; total: number }> {
        return this.findByUserIdWithLimit(options, true);
    }

    async findByUserIdForExport(options: ActivityLogQueryOptions): Promise<ActivityLog[]> {
        const { activities } = await this.findByUserIdWithLimit(options, false);
        return activities;
    }

    private async findByUserIdWithLimit(
        options: ActivityLogQueryOptions,
        enforceCap: boolean,
    ): Promise<{ activities: ActivityLog[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('activity')
            .leftJoinAndSelect('activity.work', 'work')
            .where('activity.userId = :userId', { userId: options.userId })
            .orderBy('activity.createdAt', 'DESC');

        if (options.actionType) {
            qb.andWhere('activity.actionType = :actionType', { actionType: options.actionType });
        }

        if (options.workId) {
            qb.andWhere('activity.workId = :workId', {
                workId: options.workId,
            });
        }

        if (options.status) {
            qb.andWhere('activity.status = :status', { status: options.status });
        }

        if (options.dateFrom) {
            qb.andWhere('activity.createdAt >= :dateFrom', { dateFrom: options.dateFrom });
        }

        if (options.dateTo) {
            qb.andWhere('activity.createdAt <= :dateTo', { dateTo: options.dateTo });
        }

        if (options.search) {
            const searchPattern = prepareCaseInsensitiveContainsPattern(options.search);
            if (searchPattern) {
                qb.andWhere(
                    new Brackets((searchQb) => {
                        searchQb
                            .where(buildCaseInsensitiveLikeClause('activity.summary'), {
                                search: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('work.name'), {
                                search: searchPattern,
                            });
                    }),
                );
            }
        }

        const requestedLimit = options.limit || 25;
        const limit = enforceCap ? Math.min(requestedLimit, 100) : requestedLimit;
        const offset = options.offset || 0;

        const [activities, total] = await qb.take(limit).skip(offset).getManyAndCount();

        return { activities, total };
    }

    /**
     * Live Feed — one keyset page, newest first.
     *
     * Ordered by `(createdAt DESC, id DESC)` and continued with a strict
     * "older than this `(createdAt, id)` pair" predicate, never OFFSET: rows
     * written at the head of the feed between two reads cannot shift a page
     * boundary, so nothing is skipped or repeated. The predicate is the
     * expanded `a < x OR (a = x AND b < y)` form, portable across Postgres
     * and better-sqlite3 (mirrors `AgentRunLogRepository.findTimelineByRun`).
     *
     * Always bounded by the owner AND the request's ownership scope; the
     * scope is a separate argument so no filter object can widen it.
     * Reads `limit + 1` rows to answer `hasMore` without a COUNT.
     */
    async findFeedPage(
        options: ActivityFeedQueryOptions,
        ownershipScope: OwnershipScope,
    ): Promise<ActivityFeedPageRows> {
        const postgres = this.isPostgres();
        const qb = this.repository
            .createQueryBuilder('activity')
            .leftJoin('activity.work', 'work')
            .addSelect(['work.id', 'work.name'])
            .where('activity.userId = :feedUserId', { feedUserId: options.userId })
            .andWhere('activity.createdAt >= :feedSince', { feedSince: options.since });

        const ownership = ownershipSqlPredicate('activity', ownershipScope, 'feedOwnership');
        if (ownership) {
            qb.andWhere(ownership.clause, ownership.parameters);
        }

        if (options.agentIds && options.agentIds.length > 0) {
            this.applyFeedAgentFilter(qb, options.agentIds);
        }

        if (options.kindFilter && options.kindFilter.kinds.length > 0) {
            this.applyFeedKindFilter(qb, options.kindFilter);
        }

        if (options.cursor) {
            // Postgres compares the microsecond-precise text key against the
            // column; better-sqlite3 stores milliseconds, so a Date is exact.
            const cursorCreatedAt = postgres
                ? options.cursor.createdAt
                : new Date(options.cursor.createdAt);
            qb.andWhere(
                '(activity.createdAt < :feedCursorCreatedAt OR (activity.createdAt = :feedCursorCreatedAt AND activity.id < :feedCursorId))',
                { feedCursorCreatedAt: cursorCreatedAt, feedCursorId: options.cursor.id },
            );
        }

        if (postgres) {
            qb.addSelect(
                `to_char(activity."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
                'feed_sort_key',
            );
        }

        qb.orderBy('activity.createdAt', 'DESC')
            .addOrderBy('activity.id', 'DESC')
            .limit(options.limit + 1);

        const { entities, raw } = await qb.getRawAndEntities();
        const sortKeys = new Map<string, string>();
        if (postgres) {
            for (const record of raw as Array<Record<string, unknown>>) {
                const id = record.activity_id;
                const key = record.feed_sort_key;
                if (typeof id === 'string' && typeof key === 'string') sortKeys.set(id, key);
            }
        }
        const rows = entities.slice(0, options.limit);
        for (const row of rows) {
            if (!sortKeys.has(row.id)) {
                sortKeys.set(row.id, new Date(row.createdAt).toISOString());
            }
        }
        return { rows, sortKeys, hasMore: entities.length > options.limit };
    }

    /**
     * Live Feed — entries per acting agent inside a window, busiest first.
     * Reads the indexed `actorAgentId` column only; rows that predate it are
     * read through {@link findFeedLegacyActorRows} and attributed by the
     * feed service with the same rule the feed itself uses.
     */
    async aggregateFeedActors(
        userId: string,
        ownershipScope: OwnershipScope,
        since: Date,
        /** Optional cap on groups; omitted, every acting agent is counted. */
        limit?: number,
    ): Promise<ActivityFeedActorCount[]> {
        const qb = this.repository
            .createQueryBuilder('activity')
            .select('activity.actorAgentId', 'agentId')
            .addSelect('COUNT(*)', 'count')
            .addSelect('MAX(activity.createdAt)', 'lastActivityAt')
            .where('activity.userId = :feedUserId', { feedUserId: userId })
            .andWhere('activity.actorAgentId IS NOT NULL')
            .andWhere('activity.createdAt >= :feedSince', { feedSince: since });

        const ownership = ownershipSqlPredicate('activity', ownershipScope, 'feedOwnership');
        if (ownership) {
            qb.andWhere(ownership.clause, ownership.parameters);
        }

        qb.groupBy('activity.actorAgentId').orderBy('COUNT(*)', 'DESC');
        if (typeof limit === 'number' && Number.isFinite(limit)) {
            qb.limit(Math.max(1, Math.trunc(limit)));
        }
        const raw = await qb.getRawMany<{
            agentId: unknown;
            count: string | number;
            lastActivityAt: unknown;
        }>();

        const counts: ActivityFeedActorCount[] = [];
        for (const record of raw) {
            if (typeof record.agentId !== 'string' || record.agentId.length === 0) continue;
            counts.push({
                agentId: record.agentId,
                count: Number(record.count) || 0,
                lastActivityAt: toIsoTimestamp(record.lastActivityAt),
            });
        }
        return counts;
    }

    /**
     * Live Feed — one keyset page (by id) of the rows in a window that carry
     * no stamped actor agent yet may name one in `details`: rows written
     * before the actor columns existed. The actor roster attributes them in
     * memory so its counts agree with what the per-agent filter shows.
     *
     * Deliberately narrow, so the walk stays small and ends: a row the write
     * path stamped as a person's, an external source's or the platform's is
     * skipped, as is an unstamped row of an action a person performs, and so
     * is any row whose `details` holds no agent reference (the same
     * serialized fragments {@link applyFeedAgentFilter} matches). A row
     * the activity log service writes with an agent reference gets
     * `actorAgentId` stamped, so once the older rows leave the window there
     * is normally nothing left to read. Paged by
     * id rather than timestamp, so no row is counted twice or skipped.
     */
    async findFeedLegacyActorRows(
        userId: string,
        ownershipScope: OwnershipScope,
        query: ActivityFeedLegacyActorQuery,
    ): Promise<ActivityFeedLegacyActorRow[]> {
        const qb = this.repository
            .createQueryBuilder('activity')
            .select([
                'activity.id',
                'activity.actionType',
                'activity.actorKind',
                'activity.actorAgentId',
                'activity.details',
                'activity.createdAt',
            ])
            .where('activity.userId = :feedUserId', { feedUserId: userId })
            .andWhere('activity.actorAgentId IS NULL')
            .andWhere('activity.createdAt >= :feedSince', { feedSince: query.since })
            .andWhere(
                '((activity.actorKind IS NULL AND activity.actionType NOT IN (:...feedPersonActionTypes)) OR activity.actorKind = :feedAgentActorKind)',
                {
                    feedPersonActionTypes:
                        query.personActionTypes.length > 0
                            ? [...query.personActionTypes]
                            : NO_MATCH,
                    feedAgentActorKind: 'agent',
                },
            )
            .andWhere(
                '(activity.details LIKE :feedAgentResourceType OR activity.details LIKE :feedAgentIdKey)',
                {
                    feedAgentResourceType: '%"resourceType":"agent"%',
                    feedAgentIdKey: '%"agentId":"%',
                },
            );

        const ownership = ownershipSqlPredicate('activity', ownershipScope, 'feedOwnership');
        if (ownership) {
            qb.andWhere(ownership.clause, ownership.parameters);
        }
        if (query.afterId) {
            qb.andWhere('activity.id > :feedAfterId', { feedAfterId: query.afterId });
        }

        return qb
            .orderBy('activity.id', 'ASC')
            .limit(Math.max(1, Math.trunc(query.limit)))
            .getMany();
    }

    /**
     * Live Feed agent filter. New rows carry `actorAgentId`; rows written
     * before that column existed are matched on the agent reference their
     * writer put in `details` — the same serialized-fragment LIKE
     * {@link findAgentEvents} uses, with wildcards escaped.
     */
    private applyFeedAgentFilter(qb: ActivityQueryBuilder, agentIds: readonly string[]): void {
        const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
        const ids = [...new Set(agentIds)];
        qb.andWhere(
            new Brackets((outer) => {
                outer
                    .where('activity.actorAgentId IN (:...feedAgentIds)', { feedAgentIds: ids })
                    .orWhere(
                        new Brackets((legacy) => {
                            legacy.where('activity.actorAgentId IS NULL').andWhere(
                                new Brackets((anyReference) => {
                                    ids.forEach((id, index) => {
                                        const resourceParam = `feedAgentResource${index}`;
                                        const referenceParam = `feedAgentReference${index}`;
                                        anyReference
                                            .orWhere(
                                                `activity.details LIKE :${resourceParam} ESCAPE '\\'`,
                                                {
                                                    [resourceParam]: `%"resourceId":"${escape(id)}"%`,
                                                },
                                            )
                                            .orWhere(
                                                `activity.details LIKE :${referenceParam} ESCAPE '\\'`,
                                                {
                                                    [referenceParam]: `%"agentId":"${escape(id)}"%`,
                                                },
                                            );
                                    });
                                }),
                            );
                        }),
                    );
            }),
        );
    }

    /**
     * Live Feed kind filter. A kind is derived from `(actionType, status)`,
     * so each requested kind becomes a predicate over those two columns,
     * built from the same sets the in-memory classifier uses. `problem` wins
     * over every other bucket, so the other four are all `NOT problem AND
     * ...`, and `work` is the complement of every explicitly-bucketed type —
     * which is how an action type nobody mapped still reaches it.
     */
    private applyFeedKindFilter(qb: ActivityQueryBuilder, filter: ActivityFeedKindFilter): void {
        const sets = filter.sets;
        const list = (values: readonly string[]) => (values.length > 0 ? [...values] : NO_MATCH);
        const problem =
            '(activity.status IN (:...feedProblemStatuses) OR activity.actionType IN (:...feedProblemTypes))';
        const notProblem = `NOT ${problem}`;
        const deliveredWhenCompleted =
            '(activity.actionType IN (:...feedDeliveryWhenCompletedTypes) AND activity.status = :feedCompletedStatus)';
        const runningWhenNotCompleted =
            '(activity.actionType IN (:...feedDeliveryWhenCompletedTypes) AND activity.status <> :feedCompletedStatus)';
        const branches: string[] = [];
        for (const kind of new Set(filter.kinds)) {
            switch (kind) {
                case 'problem':
                    branches.push(problem);
                    break;
                case 'decision':
                    branches.push(
                        `(${notProblem} AND activity.actionType IN (:...feedDecisionTypes))`,
                    );
                    break;
                case 'system':
                    branches.push(
                        `(${notProblem} AND activity.actionType IN (:...feedSystemTypes))`,
                    );
                    break;
                case 'delivery':
                    branches.push(
                        `(${notProblem} AND (activity.actionType IN (:...feedDeliveryTypes) OR ${deliveredWhenCompleted}))`,
                    );
                    break;
                case 'work':
                    branches.push(
                        `(${notProblem} AND (activity.actionType NOT IN (:...feedNonWorkTypes) OR ${runningWhenNotCompleted}))`,
                    );
                    break;
                default:
                    break;
            }
        }
        if (branches.length === 0) return;
        qb.andWhere(`(${branches.join(' OR ')})`, {
            feedProblemStatuses: list(sets.problemStatuses),
            feedProblemTypes: list(sets.problemActionTypes),
            feedDecisionTypes: list(sets.decisionActionTypes),
            feedSystemTypes: list(sets.systemActionTypes),
            feedDeliveryTypes: list(sets.deliveryActionTypes),
            feedDeliveryWhenCompletedTypes: list(sets.deliveryWhenCompletedActionTypes),
            feedNonWorkTypes: list([
                ...sets.problemActionTypes,
                ...sets.decisionActionTypes,
                ...sets.systemActionTypes,
                ...sets.deliveryActionTypes,
                ...sets.deliveryWhenCompletedActionTypes,
            ]),
            feedCompletedStatus: 'completed',
        });
    }

    private isPostgres(): boolean {
        return this.repository.manager?.connection?.options?.type === 'postgres';
    }

    async countByStatus(userId: string, status: ActivityStatus): Promise<number> {
        return this.repository.count({
            where: { userId, status },
        });
    }

    async countByStatuses(userId: string): Promise<Record<ActivityStatus, number>> {
        const rows = await this.repository
            .createQueryBuilder('activity')
            .select('activity.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where('activity.userId = :userId', { userId })
            .groupBy('activity.status')
            .getRawMany<{ status: ActivityStatus; count: string }>();

        let counts = {
            pending: 0,
            in_progress: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
        } as Record<ActivityStatus, number>;

        for (const row of rows) {
            counts[row.status] = Number(row.count) || 0;
        }

        return counts;
    }
}

/**
 * Normalise a raw aggregate timestamp to ISO: Postgres drivers hand back a
 * `Date`, better-sqlite3 a `YYYY-MM-DD HH:MM:SS.SSS` string stored in UTC.
 */
function toIsoTimestamp(value: unknown): string | null {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === 'string' && value.length > 0) {
        const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
        const parsed = new Date(hasZone ? value : `${value.replace(' ', 'T')}Z`);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    return null;
}
