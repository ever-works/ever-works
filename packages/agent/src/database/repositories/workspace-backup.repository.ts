import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { WorkspaceBackup } from '../../entities/workspace-backup.entity';

/**
 * Workspace backup (AW-22) — the durable record behind the backup card.
 *
 * Every method is keyed by a workspace scope — `userId` plus the active
 * `organizationId`, or `IS NULL` for the un-organized workspace — so a query
 * can never reach across two workspaces (spec FR-9). The scope is passed
 * alongside, never inside, a filter object, so no caller can widen it.
 *
 * Everything that changes a lifecycle state is a COMPARE-AND-SET expressed
 * as a bounded `UPDATE ... WHERE status IN (...)`, returning whether it
 * moved. Two tabs, a worker and the sweeper all race on these rows; a
 * read-then-write would let the sweeper mark a backup `stalled` a
 * millisecond after the worker marked it `ready`.
 *
 * Portable across Postgres and better-sqlite3 — no `unnest`, no
 * dialect-specific upsert — because CI runs the latter.
 */

/** Statuses a backup passes through before anything is decided about it. */
export const WORKSPACE_BACKUP_ACTIVE_STATUSES = ['queued', 'running'] as const;

/** Statuses that hold downloadable bytes. Only these count against the daily allowance. */
export const WORKSPACE_BACKUP_READY_STATUSES = ['ready', 'ready_with_gaps'] as const;

/** Statuses a backup never leaves. */
export const WORKSPACE_BACKUP_TERMINAL_STATUSES = [
    'ready',
    'ready_with_gaps',
    'failed',
    'cancelled',
    'expired',
    'deleted',
] as const;

/** The workspace one query may see. `organizationId: null` is the un-organized workspace. */
export interface WorkspaceBackupScope {
    readonly userId: string;
    readonly organizationId?: string | null;
    readonly tenantId?: string | null;
}

export interface CreateWorkspaceBackupInput {
    readonly includeFullHistory: boolean;
    readonly formatVersion: string;
    readonly domainsTotal: number;
    readonly buildRef?: string | null;
}

/**
 * Raised instead of a driver error when the partial unique index refuses a
 * second active backup for the same workspace (spec FR-3). The service
 * catches it and adopts the running row rather than throwing at the owner,
 * which is what makes "a backup is already running — showing that one"
 * correct in a second tab (spec S-9).
 */
export class WorkspaceBackupAlreadyActiveError extends Error {
    constructor() {
        super('A backup is already queued or running for this workspace');
        this.name = 'WorkspaceBackupAlreadyActiveError';
    }
}

export interface ListWorkspaceBackupsOptions {
    readonly limit?: number;
    /** ISO-8601 `requestedAt` of the last row of the previous page. */
    readonly cursor?: string | null;
}

export interface ListWorkspaceBackupsResult {
    readonly rows: WorkspaceBackup[];
    readonly nextCursor: string | null;
}

/** The hard ceiling on one history page, whatever the caller asks for. */
const MAX_LIST_LIMIT = 50;

@Injectable()
export class WorkspaceBackupRepository {
    constructor(
        @InjectRepository(WorkspaceBackup)
        private readonly repository: Repository<WorkspaceBackup>,
    ) {}

    /** The backup currently queued or running for this workspace, if any. */
    async findActive(scope: WorkspaceBackupScope): Promise<WorkspaceBackup | null> {
        return this.repository.findOne({
            where: {
                userId: scope.userId,
                organizationId: this.orgPredicate(scope),
                status: In([...WORKSPACE_BACKUP_ACTIVE_STATUSES]),
            },
            order: { requestedAt: 'DESC' },
        });
    }

    /** One backup, only if it belongs to this workspace. A cross-scope id reads as absent. */
    async findInScope(scope: WorkspaceBackupScope, id: string): Promise<WorkspaceBackup | null> {
        return this.repository.findOne({
            where: { id, userId: scope.userId, organizationId: this.orgPredicate(scope) },
        });
    }

    /** The most recent backup of any status, for the danger-zone banner. */
    async findLatest(scope: WorkspaceBackupScope): Promise<WorkspaceBackup | null> {
        return this.repository.findOne({
            where: { userId: scope.userId, organizationId: this.orgPredicate(scope) },
            order: { requestedAt: 'DESC' },
        });
    }

    /** The history list, newest first, keyset-paged on `requestedAt` (spec FR-30). */
    async listForScope(
        scope: WorkspaceBackupScope,
        options: ListWorkspaceBackupsOptions = {},
    ): Promise<ListWorkspaceBackupsResult> {
        const limit = Math.max(1, Math.min(options.limit ?? 20, MAX_LIST_LIMIT));
        const query = this.repository
            .createQueryBuilder('backup')
            .where('backup.userId = :userId', { userId: scope.userId });

        if (scope.organizationId) {
            query.andWhere('backup.organizationId = :organizationId', {
                organizationId: scope.organizationId,
            });
        } else {
            query.andWhere('backup.organizationId IS NULL');
        }

        if (options.cursor) {
            query.andWhere('backup.requestedAt < :cursor', { cursor: new Date(options.cursor) });
        }

        // One extra row answers "is there another page?" without a count.
        const rows = await query
            .orderBy('backup.requestedAt', 'DESC')
            .take(limit + 1)
            .getMany();
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        return {
            rows: page,
            nextCursor: hasMore && last ? new Date(last.requestedAt).toISOString() : null,
        };
    }

    /**
     * How many backups have REACHED a ready state in this workspace since
     * `since` — the spec FR-4 allowance. Failed and cancelled attempts are
     * deliberately not counted: an attempt that produced nothing must not
     * cost the owner one of their three (spec S-14, S-23). Expired and
     * deleted rows still count, because they did once hold an archive.
     */
    async countReadyInWindow(scope: WorkspaceBackupScope, since: Date): Promise<number> {
        const query = this.repository
            .createQueryBuilder('backup')
            .where('backup.userId = :userId', { userId: scope.userId })
            .andWhere('backup.status IN (:...statuses)', {
                statuses: ['ready', 'ready_with_gaps', 'expired', 'deleted'],
            })
            .andWhere('backup.requestedAt >= :since', { since });

        if (scope.organizationId) {
            query.andWhere('backup.organizationId = :organizationId', {
                organizationId: scope.organizationId,
            });
        } else {
            query.andWhere('backup.organizationId IS NULL');
        }

        return query.getCount();
    }

    /**
     * When the OLDEST backup still charged against the allowance was asked
     * for — the moment one of the three comes back is one day after this.
     *
     * The same status set and the same window as {@link countReadyInWindow},
     * asked of the database rather than derived from a page of history. The
     * service used to take the newest `allowance * 2` rows of ANY status and
     * filter them client-side, so four cancelled or failed attempts between
     * two ready ones pushed the oldest ready row off the page and the 429's
     * `retryAt` was computed from a later one — a wait reported as up to
     * nearly a day longer than it is. Counting over one set and measuring
     * over another was the defect; this is the same set.
     */
    async oldestReadyInWindow(scope: WorkspaceBackupScope, since: Date): Promise<Date | null> {
        const query = this.repository
            .createQueryBuilder('backup')
            .where('backup.userId = :userId', { userId: scope.userId })
            .andWhere('backup.status IN (:...statuses)', {
                statuses: ['ready', 'ready_with_gaps', 'expired', 'deleted'],
            })
            .andWhere('backup.requestedAt >= :since', { since });

        if (scope.organizationId) {
            query.andWhere('backup.organizationId = :organizationId', {
                organizationId: scope.organizationId,
            });
        } else {
            query.andWhere('backup.organizationId IS NULL');
        }

        const oldest = await query.orderBy('backup.requestedAt', 'ASC').take(1).getOne();
        return oldest ? new Date(oldest.requestedAt) : null;
    }

    /**
     * Insert a `queued` row. A unique violation from the partial index means
     * another tab (or another replica) won the race, and is surfaced as
     * {@link WorkspaceBackupAlreadyActiveError} so the service can adopt the
     * running row instead of throwing at the owner (spec S-9).
     */
    async createQueued(
        scope: WorkspaceBackupScope,
        input: CreateWorkspaceBackupInput,
    ): Promise<WorkspaceBackup> {
        const entity = this.repository.create({
            userId: scope.userId,
            tenantId: scope.tenantId ?? null,
            organizationId: scope.organizationId ?? null,
            status: 'queued',
            includeFullHistory: input.includeFullHistory,
            formatVersion: input.formatVersion,
            domainsTotal: input.domainsTotal,
            buildRef: input.buildRef ?? null,
            progressPercent: 0,
            domainsCompleted: 0,
            fileCount: 0,
            omittedFileCount: 0,
            downloadCount: 0,
        });

        try {
            return await this.repository.save(entity);
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                throw new WorkspaceBackupAlreadyActiveError();
            }
            throw error;
        }
    }

    /** Compare-and-set `queued` → `running`. `false` means someone else claimed it. */
    async claimForRun(id: string, startedAt: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkspaceBackup)
            .set({ status: 'running', startedAt, lastHeartbeatAt: startedAt })
            .where('id = :id', { id })
            .andWhere('status = :queued', { queued: 'queued' })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Progress report from the runner (spec FR-5). Bounded to a running row
     * so a late heartbeat can never resurrect a cancelled backup.
     */
    async heartbeat(
        id: string,
        patch: {
            progressPercent?: number;
            currentDomain?: string | null;
            domainsCompleted?: number;
            at?: Date;
        },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkspaceBackup)
            .set({
                lastHeartbeatAt: patch.at ?? new Date(),
                ...(patch.progressPercent === undefined
                    ? {}
                    : { progressPercent: patch.progressPercent }),
                ...(patch.currentDomain === undefined
                    ? {}
                    : { currentDomain: patch.currentDomain }),
                ...(patch.domainsCompleted === undefined
                    ? {}
                    : { domainsCompleted: patch.domainsCompleted }),
            })
            .where('id = :id', { id })
            .andWhere('status = :running', { running: 'running' })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Record the job-runtime handle so a cancel can reach the run. */
    async attachRuntimeRun(
        id: string,
        runtimeRunId: string | null,
        credentialVersion?: number | null,
    ): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(WorkspaceBackup)
            .set({ runtimeRunId, credentialVersion: credentialVersion ?? null })
            .where('id = :id', { id })
            .execute();
    }

    /**
     * Compare-and-set away from an active state into a terminal one. Returns
     * `false` when the row already settled, which is how a stall sweep and a
     * worker finishing at the same instant produce exactly one outcome.
     */
    async markTerminal(
        id: string,
        patch: Partial<WorkspaceBackup> & { status: string },
        from: readonly string[] = WORKSPACE_BACKUP_ACTIVE_STATUSES,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkspaceBackup)
            .set(patch)
            .where('id = :id', { id })
            .andWhere('status IN (:...from)', { from: [...from] })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Owner pressed Cancel. `false` when the backup had already settled (spec FR-8). */
    async requestCancel(id: string, at: Date): Promise<boolean> {
        return this.markTerminal(id, {
            status: 'cancelled',
            failureReason: 'cancelled_by_user',
            finishedAt: at,
        });
    }

    /** Record one download (spec §9 telemetry, FR-32's counterpart on the row). */
    async recordDownload(id: string, at: Date): Promise<void> {
        await this.repository.increment({ id }, 'downloadCount', 1);
        await this.repository.update({ id }, { lastDownloadedAt: at });
    }

    /** Sweeper pass 1 — ready archives past their retention window (spec FR-28). */
    async findExpirable(now: Date, limit: number): Promise<WorkspaceBackup[]> {
        return this.repository.find({
            where: {
                status: In([...WORKSPACE_BACKUP_READY_STATUSES]),
                expiresAt: LessThan(now),
            },
            order: { expiresAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * Sweeper pass 2 — backups that stopped reporting (spec FR-5, S-14).
     *
     * Two shapes, deliberately kept apart: a `running` row whose heartbeat
     * went quiet, and a `queued` row a worker never picked up at all (the
     * dispatcher enqueued into a runtime that is not running).
     */
    async findStalled(
        heartbeatBefore: Date,
        queuedBefore: Date,
        limit: number,
    ): Promise<WorkspaceBackup[]> {
        const running = await this.repository
            .createQueryBuilder('backup')
            .where('backup.status = :running', { running: 'running' })
            .andWhere('(backup.lastHeartbeatAt IS NULL OR backup.lastHeartbeatAt < :cutoff)', {
                cutoff: heartbeatBefore,
            })
            .orderBy('backup.requestedAt', 'ASC')
            .take(limit)
            .getMany();

        if (running.length >= limit) {
            return running;
        }

        const queued = await this.repository.find({
            where: { status: 'queued', requestedAt: LessThan(queuedBefore) },
            order: { requestedAt: 'ASC' },
            take: limit - running.length,
        });

        return [...running, ...queued];
    }

    /**
     * Sweeper pass 3 — records terminal for longer than the record retention
     * window (spec FR-29). Only rows whose bytes are already gone are
     * eligible, so a prune can never orphan an archive on storage.
     */
    async findPrunable(before: Date, limit: number): Promise<WorkspaceBackup[]> {
        return this.repository
            .createQueryBuilder('backup')
            .where('backup.status IN (:...statuses)', {
                statuses: ['failed', 'cancelled', 'expired', 'deleted'],
            })
            .andWhere('backup.finishedAt IS NOT NULL')
            .andWhere('backup.finishedAt < :before', { before })
            .andWhere('backup.storageKey IS NULL')
            .orderBy('backup.finishedAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /** Delete pruned records by id. Returns how many rows went. */
    async deleteByIds(ids: readonly string[]): Promise<number> {
        if (ids.length === 0) {
            return 0;
        }
        const result = await this.repository.delete({ id: In([...ids]) });
        return result.affected ?? 0;
    }

    private orgPredicate(scope: WorkspaceBackupScope) {
        return scope.organizationId ? scope.organizationId : IsNull();
    }

    /**
     * Postgres raises `23505` on a unique violation; better-sqlite3 says
     * "UNIQUE constraint failed". Both are recognised so the adopt path
     * behaves the same under CI as it does in production.
     */
    private isUniqueViolation(error: unknown): boolean {
        const candidate = error as {
            code?: string;
            driverError?: { code?: string };
            message?: string;
        };
        const code = candidate?.code ?? candidate?.driverError?.code;
        if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return true;
        }
        return /unique constraint|uq_workspace_backups_active/i.test(candidate?.message ?? '');
    }
}
