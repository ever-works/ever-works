import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository, type FindOptionsWhere } from 'typeorm';
import type { FleetCheckoutKind, FleetCheckoutState } from '@ever-works/contracts';
import { FleetCheckout } from '../../entities/fleet-checkout.entity';

/** Default and most rows one list page answers. */
export const FLEET_CHECKOUT_LIST_DEFAULT_LIMIT = 300;
export const FLEET_CHECKOUT_LIST_MAX_LIMIT = 1000;

export interface FleetCheckoutListQuery {
    workId?: string;
    state?: FleetCheckoutState;
    kind?: FleetCheckoutKind;
    /** Include rows in the bin. Default false: the bin is its own view (spec FR-13). */
    includeArchived?: boolean;
    limit?: number;
    /** The `id` of the last row of the previous page (rows are ordered by path, then id). */
    cursor?: string;
}

/**
 * Checkouts on computers (FL-14) — `fleet_checkouts` reads and writes. Every
 * write goes through `FleetCheckoutService`; this class answers rows and
 * nothing else (no policy, no audit).
 */
@Injectable()
export class FleetCheckoutRepository {
    constructor(
        @InjectRepository(FleetCheckout)
        private readonly repository: Repository<FleetCheckout>,
    ) {}

    async findById(id: string): Promise<FleetCheckout | null> {
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
        return this.repository.findOne({ where: { id } });
    }

    async findByPath(nodeId: string, path: string): Promise<FleetCheckout | null> {
        return this.repository.findOne({ where: { nodeId, path } });
    }

    /** Every row of one node (the reconciler reads them whole; a node holds a few hundred at most). */
    async findForNode(nodeId: string): Promise<FleetCheckout[]> {
        return this.repository.find({ where: { nodeId }, order: { path: 'ASC' } });
    }

    /** Every row of one person's nodes that has a remote (the branch rule reads their branches, FR-19). */
    async findForUser(userId: string, limit = 5000): Promise<FleetCheckout[]> {
        return this.repository
            .createQueryBuilder('checkout')
            .where('checkout.userId = :userId', { userId })
            .andWhere('checkout.remoteUrl IS NOT NULL')
            .andWhere('checkout.branch IS NOT NULL')
            .take(limit)
            .getMany();
    }

    /** One page of rows on these nodes, by path. */
    async listForNodes(
        nodeIds: readonly string[],
        query: FleetCheckoutListQuery = {},
    ): Promise<FleetCheckout[]> {
        if (nodeIds.length === 0) return [];
        const limit = Math.min(
            FLEET_CHECKOUT_LIST_MAX_LIMIT,
            Math.max(1, Math.floor(query.limit ?? FLEET_CHECKOUT_LIST_DEFAULT_LIMIT)),
        );
        const builder = this.repository
            .createQueryBuilder('checkout')
            .where('checkout.nodeId IN (:...nodeIds)', { nodeIds: [...nodeIds] });
        if (query.state) builder.andWhere('checkout.state = :state', { state: query.state });
        else if (!query.includeArchived)
            builder.andWhere('checkout.state != :archived', { archived: 'archived' });
        if (query.kind) builder.andWhere('checkout.kind = :kind', { kind: query.kind });
        if (query.workId) builder.andWhere('checkout.workId = :workId', { workId: query.workId });
        if (query.cursor) {
            const after = await this.findById(query.cursor);
            if (after) {
                builder.andWhere(
                    '(checkout.path > :afterPath OR (checkout.path = :afterPath AND checkout.id > :afterId))',
                    { afterPath: after.path, afterId: after.id },
                );
            }
        }
        return builder
            .orderBy('checkout.path', 'ASC')
            .addOrderBy('checkout.id', 'ASC')
            .take(limit)
            .getMany();
    }

    /** Rows in the bin on these nodes (the "Bin (n)" count). */
    async countArchived(nodeIds: readonly string[]): Promise<number> {
        if (nodeIds.length === 0) return 0;
        return this.repository.count({
            where: { nodeId: In([...nodeIds]), state: 'archived' },
        });
    }

    async create(data: Partial<FleetCheckout>): Promise<FleetCheckout> {
        return this.repository.save(this.repository.create(data));
    }

    async update(id: string, patch: Partial<FleetCheckout>): Promise<void> {
        if (Object.keys(patch).length === 0) return;
        await this.repository.update({ id }, patch);
    }

    /**
     * Compare-and-set on `updatedAt` (the reconcile sweep's idempotency, plan
     * §10): true when this write won, false when someone changed the row first.
     */
    async updateIfUnchanged(
        row: Pick<FleetCheckout, 'id' | 'updatedAt'>,
        patch: Partial<FleetCheckout>,
    ): Promise<boolean> {
        const where: FindOptionsWhere<FleetCheckout> = { id: row.id, updatedAt: row.updatedAt };
        const result = await this.repository.update(where, patch);
        return (result.affected ?? 0) > 0;
    }

    /** Rows stuck in `creating` since before `cutoff` (the 10-minute sweep). */
    async findCreatingBefore(cutoff: Date, limit = 200): Promise<FleetCheckout[]> {
        return this.repository.find({
            where: { state: 'creating', createdAt: LessThan(cutoff) },
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    /** Node ids that hold at least one checkout outside the bin (the reconcile sweep asks them). */
    async nodeIdsWithCheckouts(limit = 500): Promise<string[]> {
        const rows = await this.repository
            .createQueryBuilder('checkout')
            .select('DISTINCT checkout.nodeId', 'nodeId')
            .where('checkout.state != :archived', { archived: 'archived' })
            .limit(limit)
            .getRawMany<{ nodeId: string }>();
        return rows.map((row) => row.nodeId).filter((id) => typeof id === 'string');
    }

    /** Rows in the bin since before `cutoff` (the bin purge, P3), oldest first, bounded. */
    async findArchivedBefore(cutoff: Date, limit = 500): Promise<FleetCheckout[]> {
        return this.repository.find({
            where: { state: 'archived', archivedAt: LessThan(cutoff) },
            order: { archivedAt: 'ASC' },
            take: limit,
        });
    }

    /** Remove rows by id (the bin purge). */
    async deleteMany(ids: readonly string[]): Promise<void> {
        if (ids.length === 0) return;
        await this.repository.delete({ id: In([...ids]) });
    }

    /** Remove a row outright (a `discovered` checkout's Forget, P2). */
    async delete(id: string): Promise<void> {
        await this.repository.delete({ id });
    }
}
