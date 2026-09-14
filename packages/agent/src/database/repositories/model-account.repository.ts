import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, In, IsNull, LessThan, Repository } from 'typeorm';
import { ModelAccount } from '../../entities/model-account.entity';
import { advisoryLockObjectId } from './agent-run.repository';

/**
 * Model accounts (AW-16) — advisory-lock namespace (`classid`) for writes to a
 * workspace's accounts for one provider. Apart from run admission
 * (`0x6577_0001`), live-view admission (`0x6577_000b` / `0x6577_000c`) and
 * send admission (`0x6577_0e01` / `0x6577_0e02`). Arbitrary but STABLE:
 * changing it would make an old and a new replica lock on different keys
 * during a rolling restart — exactly the window the lock exists for.
 */
export const MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID = 0x6577_1601 | 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The advisory-lock key for one workspace's accounts of one provider. A write
 * that is not about one provider (`null`) locks the workspace as a whole.
 */
export function modelAccountWriteLockKey(
    workspaceKey: string,
    providerPluginId: string | null,
): string {
    return providerPluginId
        ? `model-accounts:${workspaceKey}:${providerPluginId}`
        : `model-accounts:${workspaceKey}`;
}

/**
 * Model accounts (AW-16) — repository for `model_accounts`.
 *
 * Every lookup a person can trigger is keyed on the workspace
 * (`...InWorkspace`): an id from another workspace finds nothing, which the
 * API turns into the same 404 a missing id gets. The unscoped reads serve the
 * call path and the periodic health check, which work from ids the server
 * already resolved.
 */
@Injectable()
export class ModelAccountRepository {
    constructor(
        @InjectRepository(ModelAccount)
        private readonly repository: Repository<ModelAccount>,
    ) {}

    create(entry: Partial<ModelAccount>): ModelAccount {
        return this.repository.create(entry);
    }

    async save(entry: ModelAccount): Promise<ModelAccount> {
        return this.repository.save(entry);
    }

    /**
     * Run `work` in one transaction with a repository bound to it, serialized
     * against every other write to the same workspace's accounts of the same
     * provider.
     *
     * POSTGRES: first takes `pg_advisory_xact_lock` keyed by workspace and
     * provider ({@link modelAccountWriteLockKey}), then row-locks the
     * provider's existing rows. The row lock alone cannot serialize the FIRST
     * adds for a provider — with no rows there is nothing to lock, and two
     * concurrent adds would both pass the limit count. The advisory lock
     * exists whether or not rows do, and is held until this transaction
     * commits, so the next writer's count sees the row just written. A failure
     * to take the lock fails the write with nothing written: unlike the run
     * admission valve, the account limit is a hard rule, not a safety valve.
     *
     * EVERY OTHER DRIVER (better-sqlite3 — the e2e/CI stack): advisory and row
     * locks do not exist, so both are a documented no-op and `work` runs in a
     * plain transaction, as before.
     */
    async inTransaction<T>(
        workspaceKey: string,
        providerPluginId: string | null,
        work: (tx: Repository<ModelAccount>) => Promise<T>,
    ): Promise<T> {
        return this.repository.manager.transaction(async (manager: EntityManager) => {
            const tx = manager.getRepository(ModelAccount);
            if (manager.connection.options.type === 'postgres') {
                await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
                    MODEL_ACCOUNT_WRITE_LOCK_CLASS_ID,
                    advisoryLockObjectId(modelAccountWriteLockKey(workspaceKey, providerPluginId)),
                ]);
                const query = tx
                    .createQueryBuilder('account')
                    .select('account.id')
                    .where('account.workspaceKey = :workspaceKey', { workspaceKey })
                    .setLock('pessimistic_write');
                if (providerPluginId) {
                    query.andWhere('account.providerPluginId = :providerPluginId', {
                        providerPluginId,
                    });
                }
                await query.getMany();
            }
            return work(tx);
        });
    }

    async listInWorkspace(
        workspaceKey: string,
        providerPluginId?: string,
    ): Promise<ModelAccount[]> {
        return this.repository.find({
            where: providerPluginId ? { workspaceKey, providerPluginId } : { workspaceKey },
            order: { providerPluginId: 'ASC', position: 'ASC' },
        });
    }

    async findInWorkspace(id: string, workspaceKey: string): Promise<ModelAccount | null> {
        return this.repository.findOne({ where: { id, workspaceKey } });
    }

    async findById(id: string): Promise<ModelAccount | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * The workspace and provider of each id that exists (one `IN` query, no
     * credentials read). Serves run-cost settlement, which checks that the
     * account named on a usage row belongs to the run's workspace. An id that
     * is not a UUID cannot name an account and is dropped before the query
     * (Postgres would reject the whole `IN` list over it).
     */
    async findOwnershipByIds(
        ids: readonly string[],
    ): Promise<Array<Pick<ModelAccount, 'id' | 'workspaceKey' | 'providerPluginId'>>> {
        const candidates = [...new Set(ids)].filter((id) => UUID_PATTERN.test(id));
        if (candidates.length === 0) return [];
        return this.repository.find({
            where: { id: In(candidates) },
            select: { id: true, workspaceKey: true, providerPluginId: true },
        });
    }

    /** True when any account exists anywhere — the call path's cheapest "is this feature in use" probe. */
    async anyExist(): Promise<boolean> {
        const row = await this.repository.findOne({ where: {}, select: { id: true } });
        return !!row;
    }

    async existsInWorkspace(workspaceKey: string): Promise<boolean> {
        const row = await this.repository.findOne({
            where: { workspaceKey },
            select: { id: true },
        });
        return !!row;
    }

    /**
     * Stamp `lastUsedAt`, at most once a minute per account: the write only
     * lands when the stored value is older than `notBefore`.
     */
    async touchLastUsed(id: string, now: Date, notBefore: Date): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(ModelAccount)
            .set({ lastUsedAt: now })
            .where('id = :id', { id })
            .andWhere(
                new Brackets((where) => {
                    where
                        .where('lastUsedAt IS NULL')
                        .orWhere('lastUsedAt < :notBefore', { notBefore });
                }),
            )
            .execute();
    }

    async updateHealth(
        id: string,
        patch: Pick<Partial<ModelAccount>, 'health' | 'lastCheckedAt' | 'credentialExpiresAt'>,
    ): Promise<void> {
        await this.repository.update({ id }, patch);
    }

    /** Enabled accounts whose last check is older than `cutoff` (or never ran), oldest first. */
    async listDueForCheck(cutoff: Date, limit: number): Promise<ModelAccount[]> {
        return this.repository.find({
            where: [
                { enabled: true, lastCheckedAt: IsNull() },
                { enabled: true, lastCheckedAt: LessThan(cutoff) },
            ],
            order: { lastCheckedAt: 'ASC' },
            take: limit,
        });
    }

    /**
     * Claim one account for a check: stamps `lastCheckedAt` only if it is
     * still older than `cutoff`, so two overlapping health ticks cannot both
     * probe the same account. Returns true when this caller won the claim.
     */
    async claimForCheck(id: string, now: Date, cutoff: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ModelAccount)
            .set({ lastCheckedAt: now })
            .where('id = :id', { id })
            .andWhere(
                new Brackets((where) => {
                    where
                        .where('lastCheckedAt IS NULL')
                        .orWhere('lastCheckedAt < :cutoff', { cutoff });
                }),
            )
            .execute();
        return (result.affected ?? 0) > 0;
    }
}
