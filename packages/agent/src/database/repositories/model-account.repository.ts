import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, IsNull, LessThan, Repository } from 'typeorm';
import { ModelAccount } from '../../entities/model-account.entity';

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
     * Run `work` in one transaction with a repository bound to it. On Postgres
     * the workspace's rows for the provider are locked first so two concurrent
     * writes serialize on the count and the positions they read.
     */
    async inTransaction<T>(
        workspaceKey: string,
        providerPluginId: string | null,
        work: (tx: Repository<ModelAccount>) => Promise<T>,
    ): Promise<T> {
        return this.repository.manager.transaction(async (manager: EntityManager) => {
            const tx = manager.getRepository(ModelAccount);
            if (manager.connection.options.type === 'postgres') {
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
