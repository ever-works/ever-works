import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, LessThan, Not, Repository, type SelectQueryBuilder } from 'typeorm';
import type { MemoryFactCounts, MemoryFactScope, MemoryFactStatus } from '@ever-works/contracts';
import { MemoryFact } from '../../entities/memory-fact.entity';
import { buildCaseInsensitiveLikeClause, prepareCaseInsensitiveContainsPattern } from '../utils';
import { ownershipSqlPredicate, ownershipWhereWith, type OwnershipScope } from '../ownership-scope';
import { advisoryLockObjectId } from './agent-run.repository';

/**
 * Advisory-lock namespace (`classid`) for memory-fact writes in one
 * workspace. Apart from run admission (`0x6577_0001`), live-view admission
 * (`0x6577_000b` / `0x6577_000c`) and email send admission
 * (`0x6577_0e01` / `0x6577_0e02`). Arbitrary but STABLE: changing it would
 * make an old and a new replica lock on different keys during a rolling
 * restart — exactly the window the lock exists for.
 */
export const MEMORY_FACT_WRITE_LOCK_CLASS_ID = 0x6577_0701 | 0;

/**
 * The provider-selection scope of a fact: the owner and the Organization.
 * Embeddings resolve the AI provider per user and vectors resolve the store
 * per `(user, workspace namespace)`, so two facts can only be compared for
 * embedding drift inside one of these.
 */
export interface MemoryFactEmbeddingScope {
    userId: string;
    organizationId: string | null;
}

/** The workspace key one write lock serializes on. */
export function memoryFactWriteLockKey(
    userId: string,
    ownership: OwnershipScope | undefined,
): string {
    return `memory-facts:${userId}:${ownership?.tenantId ?? '-'}:${ownership?.organizationId ?? '-'}`;
}

/**
 * In-process tail of every workspace's write chain. Process-wide on purpose:
 * the transaction-bound repository `withWorkspaceWriteLock` hands to its
 * callback is a separate instance and must not open a second chain.
 */
const workspaceWriteChains = new Map<string, Promise<void>>();

/** Run `fn` after every earlier call with the same key has settled. */
async function serializeInProcess<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = workspaceWriteChains.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(
        () => undefined,
        () => undefined,
    );
    workspaceWriteChains.set(key, tail);
    try {
        return await run;
    } finally {
        if (workspaceWriteChains.get(key) === tail) {
            workspaceWriteChains.delete(key);
        }
    }
}

/** Filters accepted by {@link MemoryFactRepository.listForOwner}. */
export interface ListMemoryFactsFilter {
    /** Defaults to `active` — the "All" view lists live facts. */
    status?: MemoryFactStatus;
    pinnedOnly?: boolean;
    scope?: MemoryFactScope;
    agentId?: string;
    limit: number;
    offset?: number;
}

/** Fields a new fact is created with. Scope columns come from `ownership`. */
export interface CreateMemoryFactInput {
    userId: string;
    ownership?: OwnershipScope;
    body: string;
    status: MemoryFactStatus;
    origin: MemoryFact['origin'];
    scope: MemoryFactScope;
    agentId: string | null;
    pinned: boolean;
    sourceRunId?: string | null;
    sourceConversationId?: string | null;
    sourceAgentId?: string | null;
}

/** Vector coordinates recorded after a successful embed. */
export interface MemoryFactEmbeddingCoordinates {
    vectorStoreId: string;
    embeddingModel: string;
    embeddingDims: number;
    embeddedAt: Date;
}

/** Slim projection the purge sweep needs to delete a vector. */
export interface MemoryFactPurgeRow {
    id: string;
    userId: string;
    organizationId: string | null;
    vectorStoreId: string | null;
}

/**
 * Persistence for `memory_facts` (AW-07).
 *
 * ## Two kinds of method, and the line between them
 *
 * **Owner-scoped** methods take `(userId, ownership)` and apply the shared
 * Tier C predicate (`ownershipSqlPredicate` / `ownershipWhereWith`) on every
 * statement, so a fact id from another workspace resolves to nothing — the
 * service maps that to 404. Every request path uses only these.
 *
 * **Sweep** methods (`dueForPurge`, `dueForEmbed`, `embeddedScopes`,
 * `dueForReembed`, `findProbeCandidate`, `findForEmbedding`, `markEmbedded`,
 * `deleteByIds`) are keyed by fact id or
 * run across every workspace. They exist for the nightly background sweep,
 * which has no request scope, and are never reachable from a controller.
 *
 * Invariants (caps, status transitions, duplicate defence) live in
 * `MemoryFactService`; this class is deliberately a thin query layer.
 */
@Injectable()
export class MemoryFactRepository {
    private readonly logger = new Logger(MemoryFactRepository.name);

    constructor(
        @InjectRepository(MemoryFact)
        private readonly repo: Repository<MemoryFact>,
    ) {}

    // ─── Write serialization ────────────────────────────────────────────────

    /**
     * Serialize one workspace's check-then-write (capacity, pin cap,
     * duplicate body, status transition) against every other write in the
     * same workspace, so two simultaneous requests can never both see the
     * last free slot — or no duplicate — and both insert. The run-admission
     * lock's pattern (`AgentRunRepository.withAdmissionLock`) in its own
     * namespace.
     *
     * IN PROCESS (every driver): calls with the same workspace key run one
     * after another. That alone closes the race on better-sqlite3, whose
     * single connection only ever serves the one process holding it, and on
     * Postgres it keeps a burst of waiters from each holding a pool
     * connection.
     *
     * POSTGRES, additionally: opens ONE transaction, takes
     * `pg_advisory_xact_lock` on the workspace key, and runs `fn` with a
     * repository bound to THAT transaction. The counts, the duplicate check
     * and the write commit together and the lock is released by that same
     * commit, so a write on another API replica starts its checks only after
     * this one's row is visible.
     *
     * A failure to TAKE the lock degrades to running `fn` unlocked (logged),
     * like the run-admission lock: a broken lock must never make a fact
     * un-saveable. A failure INSIDE `fn` (or its commit) is re-raised and
     * `fn` is never re-run, since it may already have written.
     *
     * Not re-entrant: `fn` must not call this method again for the same key.
     */
    async withWorkspaceWriteLock<T>(
        userId: string,
        ownership: OwnershipScope | undefined,
        fn: (facts: MemoryFactRepository) => Promise<T>,
    ): Promise<T> {
        const key = memoryFactWriteLockKey(userId, ownership);
        return serializeInProcess(key, async () => {
            const connection = this.repo.manager.connection;
            if (connection.options.type !== 'postgres') {
                return fn(this);
            }
            let entered = false;
            try {
                return await connection.transaction(async (manager) => {
                    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
                        MEMORY_FACT_WRITE_LOCK_CLASS_ID,
                        advisoryLockObjectId(key),
                    ]);
                    entered = true;
                    return fn(new MemoryFactRepository(manager.getRepository(MemoryFact)));
                });
            } catch (error) {
                if (entered) throw error;
                this.logger.warn(
                    `Memory-fact write lock unavailable — writing unlocked: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                return fn(this);
            }
        });
    }

    // ─── Owner-scoped ───────────────────────────────────────────────────────

    /** One page of facts, newest first, plus the total for the same filter. */
    async listForOwner(
        userId: string,
        ownership: OwnershipScope | undefined,
        filter: ListMemoryFactsFilter,
    ): Promise<{ rows: MemoryFact[]; total: number }> {
        const qb = this.ownedQuery(userId, ownership);
        this.applyFilter(qb, filter);
        qb.orderBy('fact.createdAt', 'DESC').addOrderBy('fact.id', 'DESC');
        qb.take(filter.limit).skip(filter.offset ?? 0);
        const [rows, total] = await qb.getManyAndCount();
        return { rows, total };
    }

    /** Case-insensitive substring match over the body, newest first. */
    async searchLiteral(
        userId: string,
        ownership: OwnershipScope | undefined,
        query: string,
        filter: Omit<ListMemoryFactsFilter, 'offset'>,
    ): Promise<MemoryFact[]> {
        const pattern = prepareCaseInsensitiveContainsPattern(query);
        if (!pattern) return [];
        const qb = this.ownedQuery(userId, ownership);
        this.applyFilter(qb, filter);
        qb.andWhere(buildCaseInsensitiveLikeClause('fact.body', 'factBodyPattern'), {
            factBodyPattern: pattern,
        });
        qb.orderBy('fact.createdAt', 'DESC').addOrderBy('fact.id', 'DESC').take(filter.limit);
        return qb.getMany();
    }

    /** Counts per status plus the active pinned count, for the rail. */
    async countByStatus(
        userId: string,
        ownership: OwnershipScope | undefined,
    ): Promise<MemoryFactCounts> {
        const qb = this.ownedQuery(userId, ownership)
            .select('fact.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .groupBy('fact.status');
        const rows: Array<{ status: string; count: string | number }> = await qb.getRawMany();
        const counts: MemoryFactCounts = { proposed: 0, active: 0, forgotten: 0, pinned: 0 };
        for (const row of rows) {
            if (
                row.status === 'proposed' ||
                row.status === 'active' ||
                row.status === 'forgotten'
            ) {
                counts[row.status] = Number(row.count);
            }
        }
        counts.pinned = await this.ownedQuery(userId, ownership)
            .andWhere('fact.status = :pinnedStatus', { pinnedStatus: 'active' })
            .andWhere('fact.pinned = :pinnedFlag', { pinnedFlag: true })
            .getCount();
        return counts;
    }

    async findOwned(
        id: string,
        userId: string,
        ownership: OwnershipScope | undefined,
    ): Promise<MemoryFact | null> {
        return this.repo.findOne({
            where: ownershipWhereWith<MemoryFact>(userId, ownership, { id }),
        });
    }

    /** Hydrate ids returned by a vector query — anything not owned is silently dropped. */
    async findOwnedByIds(
        ids: readonly string[],
        userId: string,
        ownership: OwnershipScope | undefined,
    ): Promise<MemoryFact[]> {
        if (ids.length === 0) return [];
        return this.repo.find({
            where: ownershipWhereWith<MemoryFact>(userId, ownership, { id: In([...ids]) }),
        });
    }

    /**
     * A live (non-forgotten) fact in the same workspace whose body equals
     * `body` case-insensitively — the exact-duplicate defence.
     */
    async findLiveDuplicate(
        userId: string,
        ownership: OwnershipScope | undefined,
        body: string,
        excludeId?: string,
    ): Promise<MemoryFact | null> {
        const qb = this.ownedQuery(userId, ownership)
            .andWhere('fact.status != :forgottenStatus', { forgottenStatus: 'forgotten' })
            .andWhere('LOWER(fact.body) = :lowerBody', { lowerBody: body.toLowerCase() });
        if (excludeId) {
            qb.andWhere('fact.id != :excludeId', { excludeId });
        }
        return qb.getOne();
    }

    async create(input: CreateMemoryFactInput): Promise<MemoryFact> {
        const entity = this.repo.create({
            userId: input.userId,
            // Explicit stamp when a request scope exists; omitted legacy calls
            // keep the subscriber behaviour (same contract as `ownershipStamp`).
            ...(input.ownership
                ? {
                      tenantId: input.ownership.tenantId,
                      organizationId: input.ownership.organizationId,
                  }
                : {}),
            body: input.body,
            status: input.status,
            origin: input.origin,
            scope: input.scope,
            agentId: input.agentId,
            pinned: input.pinned,
            sourceRunId: input.sourceRunId ?? null,
            sourceConversationId: input.sourceConversationId ?? null,
            sourceAgentId: input.sourceAgentId ?? null,
        });
        return this.repo.save(entity);
    }

    /**
     * Apply `patch` to an owned fact and return the fresh row, or `null`
     * when the id is not owned. The owner predicate is on the UPDATE itself,
     * so a cross-workspace id can never be written even if a caller skipped
     * the read.
     */
    async updateOwned(
        id: string,
        userId: string,
        ownership: OwnershipScope | undefined,
        patch: Partial<
            Pick<
                MemoryFact,
                | 'body'
                | 'status'
                | 'scope'
                | 'agentId'
                | 'pinned'
                | 'forgottenAt'
                | 'vectorStoreId'
                | 'embeddingModel'
                | 'embeddingDims'
                | 'embeddedAt'
            >
        >,
    ): Promise<MemoryFact | null> {
        const qb = this.repo
            .createQueryBuilder()
            .update(MemoryFact)
            .set({ ...patch, updatedAt: () => 'CURRENT_TIMESTAMP' })
            .where('id = :id', { id })
            .andWhere('userId = :userId', { userId });
        const predicate = ownershipSqlPredicate('', ownership, 'factScope');
        if (predicate) {
            qb.andWhere(predicate.clause, predicate.parameters);
        }
        const result = await qb.execute();
        if (!result.affected) {
            return null;
        }
        return this.findOwned(id, userId, ownership);
    }

    /**
     * Forget every active and proposed fact in the workspace. Touches
     * `memory_facts` and nothing else — context files, agent files, uploads,
     * meetings and Knowledge Base documents live in other tables and are not
     * named in this statement.
     */
    async forgetAll(
        userId: string,
        ownership: OwnershipScope | undefined,
        now: Date,
    ): Promise<number> {
        const qb = this.repo
            .createQueryBuilder()
            .update(MemoryFact)
            .set({
                status: 'forgotten',
                forgottenAt: now,
                pinned: false,
                updatedAt: () => 'CURRENT_TIMESTAMP',
            })
            .where('userId = :userId', { userId })
            .andWhere('status IN (:...liveStatuses)', { liveStatuses: ['active', 'proposed'] });
        const predicate = ownershipSqlPredicate('', ownership, 'factScope');
        if (predicate) {
            qb.andWhere(predicate.clause, predicate.parameters);
        }
        const result = await qb.execute();
        return result.affected ?? 0;
    }

    // ─── Sweep (no request scope; never reachable from a controller) ────────

    /** Facts forgotten before `cutoff`, oldest first — the purge set. */
    async dueForPurge(cutoff: Date, limit: number): Promise<MemoryFactPurgeRow[]> {
        const rows = await this.repo.find({
            select: { id: true, userId: true, organizationId: true, vectorStoreId: true },
            where: { status: 'forgotten', forgottenAt: LessThan(cutoff) },
            order: { forgottenAt: 'ASC' },
            take: limit,
        });
        return rows.map((row) => ({
            id: row.id,
            userId: row.userId,
            organizationId: row.organizationId ?? null,
            vectorStoreId: row.vectorStoreId ?? null,
        }));
    }

    /** Live facts that have never been embedded (or whose body changed since). */
    async dueForEmbed(limit: number): Promise<MemoryFact[]> {
        return this.repo.find({
            where: { status: Not('forgotten'), embeddedAt: IsNull() },
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * The provider-selection scopes that hold live embedded facts, the scope
     * whose oldest embed is oldest first — so a pass that runs out of budget
     * starts from a different scope next time instead of re-checking the
     * same ones.
     */
    async embeddedScopes(limit: number): Promise<MemoryFactEmbeddingScope[]> {
        const rows: Array<{ userId: string; organizationId: string | null }> = await this.repo
            .createQueryBuilder('fact')
            .select('fact.userId', 'userId')
            .addSelect('fact.organizationId', 'organizationId')
            .where('fact.status != :forgottenStatus', { forgottenStatus: 'forgotten' })
            .andWhere('fact.embeddedAt IS NOT NULL')
            .groupBy('fact.userId')
            .addGroupBy('fact.organizationId')
            .orderBy('MIN(fact.embeddedAt)', 'ASC')
            .limit(limit)
            .getRawMany();
        return rows.map((row) => ({
            userId: row.userId,
            organizationId: row.organizationId ?? null,
        }));
    }

    /**
     * Live embedded facts whose coordinates no longer match the current model / store.
     *
     * Pass `scope` to compare only the facts of one provider-selection scope
     * against the coordinates learned IN that scope — the only comparison
     * that means anything when different owners use different providers.
     */
    async dueForReembed(
        current: { embeddingModel: string; embeddingDims: number; vectorStoreId: string },
        limit: number,
        scope?: MemoryFactEmbeddingScope,
    ): Promise<MemoryFact[]> {
        const qb = this.repo
            .createQueryBuilder('fact')
            .where('fact.status != :forgottenStatus', { forgottenStatus: 'forgotten' })
            .andWhere('fact.embeddedAt IS NOT NULL');
        if (scope) {
            this.applyEmbeddingScope(qb, scope);
        }
        return qb
            .andWhere(
                new Brackets((drift) => {
                    drift
                        .where('fact.embeddingModel != :currentModel', {
                            currentModel: current.embeddingModel,
                        })
                        .orWhere('fact.embeddingDims != :currentDims', {
                            currentDims: current.embeddingDims,
                        })
                        .orWhere('fact.vectorStoreId != :currentStore', {
                            currentStore: current.vectorStoreId,
                        });
                }),
            )
            .orderBy('fact.embeddedAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * One live embedded fact, oldest embed first — used to learn the current model.
     *
     * With `scope`, only an already-embedded fact of that provider-selection
     * scope qualifies, so the model learned is the one that scope embeds with.
     */
    async findProbeCandidate(scope?: MemoryFactEmbeddingScope): Promise<MemoryFact | null> {
        if (!scope) {
            return this.repo.findOne({
                where: { status: Not('forgotten') },
                order: { embeddedAt: 'ASC', createdAt: 'ASC' },
            });
        }
        const qb = this.repo
            .createQueryBuilder('fact')
            .where('fact.status != :forgottenStatus', { forgottenStatus: 'forgotten' })
            .andWhere('fact.embeddedAt IS NOT NULL');
        this.applyEmbeddingScope(qb, scope);
        return qb.orderBy('fact.embeddedAt', 'ASC').addOrderBy('fact.createdAt', 'ASC').getOne();
    }

    /** Load one fact by id for the embed job (the job carries no request scope). */
    async findForEmbedding(id: string): Promise<MemoryFact | null> {
        return this.repo.findOne({ where: { id } });
    }

    /**
     * Record the vector coordinates — but only if the body is still the one
     * that was embedded. An edit that landed while the embed was in flight
     * clears `embeddedAt`, and this guard stops the stale vector's coordinates
     * from overwriting that. Returns whether the row was updated.
     */
    async markEmbedded(
        id: string,
        embeddedBody: string,
        coordinates: MemoryFactEmbeddingCoordinates,
    ): Promise<boolean> {
        const result = await this.repo
            .createQueryBuilder()
            .update(MemoryFact)
            .set({
                vectorStoreId: coordinates.vectorStoreId,
                embeddingModel: coordinates.embeddingModel,
                embeddingDims: coordinates.embeddingDims,
                embeddedAt: coordinates.embeddedAt,
            })
            .where('id = :id', { id })
            .andWhere('body = :embeddedBody', { embeddedBody })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async deleteByIds(ids: readonly string[]): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await this.repo.delete({ id: In([...ids]) });
        return result.affected ?? 0;
    }

    // ─── internals ──────────────────────────────────────────────────────────

    private ownedQuery(
        userId: string,
        ownership: OwnershipScope | undefined,
    ): SelectQueryBuilder<MemoryFact> {
        const qb = this.repo
            .createQueryBuilder('fact')
            .where('fact.userId = :factOwnerId', { factOwnerId: userId });
        const predicate = ownershipSqlPredicate('fact', ownership, 'factScope');
        if (predicate) {
            qb.andWhere(predicate.clause, predicate.parameters);
        }
        return qb;
    }

    private applyEmbeddingScope(
        qb: SelectQueryBuilder<MemoryFact>,
        scope: MemoryFactEmbeddingScope,
    ): void {
        qb.andWhere('fact.userId = :embedScopeUserId', { embedScopeUserId: scope.userId });
        if (scope.organizationId) {
            qb.andWhere('fact.organizationId = :embedScopeOrgId', {
                embedScopeOrgId: scope.organizationId,
            });
        } else {
            qb.andWhere('fact.organizationId IS NULL');
        }
    }

    private applyFilter(
        qb: SelectQueryBuilder<MemoryFact>,
        filter: Omit<ListMemoryFactsFilter, 'limit' | 'offset'>,
    ): void {
        qb.andWhere('fact.status = :factStatus', { factStatus: filter.status ?? 'active' });
        if (filter.pinnedOnly) {
            qb.andWhere('fact.pinned = :factPinned', { factPinned: true });
        }
        if (filter.scope) {
            qb.andWhere('fact.scope = :factScopeKind', { factScopeKind: filter.scope });
        }
        if (filter.agentId) {
            qb.andWhere('fact.agentId = :factAgentId', { factAgentId: filter.agentId });
        }
    }
}
