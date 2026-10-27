import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { FleetActionsRunner } from '../../entities/fleet-actions-runner.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Actions runners on computers (FL-18) — `fleet_actions_runners` reads and
 * writes. Every write goes through `FleetActionsRunnersService`; this class
 * answers rows and nothing else (no policy, no audit). "Listed" rows are the
 * ones not removed (`removedAt IS NULL`).
 */
@Injectable()
export class FleetActionsRunnerRepository {
    constructor(
        @InjectRepository(FleetActionsRunner)
        private readonly repository: Repository<FleetActionsRunner>,
    ) {}

    async findById(id: string): Promise<FleetActionsRunner | null> {
        if (typeof id !== 'string' || !UUID.test(id)) return null;
        return this.repository.findOne({ where: { id } });
    }

    async findByIds(ids: readonly string[]): Promise<FleetActionsRunner[]> {
        const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && UUID.test(id)))];
        if (wanted.length === 0) return [];
        return this.repository.find({ where: { id: In(wanted) } });
    }

    /** The runners still on one computer, by name. */
    async listForNode(nodeId: string): Promise<FleetActionsRunner[]> {
        if (typeof nodeId !== 'string' || !UUID.test(nodeId)) return [];
        return this.repository.find({
            where: { nodeId, removedAt: IsNull() },
            order: { name: 'ASC' },
        });
    }

    /** The runners still on any of these computers (one batched read for a hub page). */
    async listForNodes(nodeIds: readonly string[]): Promise<FleetActionsRunner[]> {
        const wanted = [
            ...new Set(nodeIds.filter((id) => typeof id === 'string' && UUID.test(id))),
        ];
        if (wanted.length === 0) return [];
        return this.repository.find({
            where: { nodeId: In(wanted), removedAt: IsNull() },
            order: { nodeId: 'ASC', name: 'ASC' },
        });
    }

    /** Every listed runner of one owner (the poll's and the jobs panel's read). */
    async listForOwner(ownerUserId: string): Promise<FleetActionsRunner[]> {
        if (typeof ownerUserId !== 'string' || !UUID.test(ownerUserId)) return [];
        return this.repository.find({
            where: { ownerUserId, removedAt: IsNull() },
            order: { name: 'ASC' },
        });
    }

    /** The owners with at least one listed runner (the off-page poll's fan-out). */
    async listOwnersWithRunners(limit = 1000): Promise<string[]> {
        const rows = await this.repository
            .createQueryBuilder('runner')
            .select('runner.ownerUserId', 'ownerUserId')
            .where('runner.removedAt IS NULL')
            .groupBy('runner.ownerUserId')
            .limit(limit)
            .getRawMany<{ ownerUserId: string }>();
        return rows.map((row) => row.ownerUserId).filter((id) => typeof id === 'string');
    }

    /** How many runners are still on one computer (CONTRACTS §10: 16). */
    async countForNode(nodeId: string): Promise<number> {
        if (typeof nodeId !== 'string' || !UUID.test(nodeId)) return 0;
        return this.repository.count({ where: { nodeId, removedAt: IsNull() } });
    }

    async create(data: Partial<FleetActionsRunner>): Promise<FleetActionsRunner> {
        return this.repository.save(this.repository.create(data));
    }

    async update(id: string, patch: Partial<FleetActionsRunner>): Promise<void> {
        if (!UUID.test(id)) return;
        await this.repository.update(
            { id },
            patch as Parameters<Repository<FleetActionsRunner>['update']>[1],
        );
    }

    /** Hard delete (an install that never produced anything is taken back). */
    async delete(id: string): Promise<void> {
        if (!UUID.test(id)) return;
        await this.repository.delete({ id });
    }

    /** Removed rows past their 30 days (the audit trail keeps the history). */
    async purgeRemovedBefore(cutoff: Date): Promise<number> {
        const result = await this.repository.delete({
            removedAt: LessThan(cutoff),
            state: 'removed',
        });
        return result.affected ?? 0;
    }

    /** Listed rows of a node that are not in `keepIds` — for a reconcile that names the node's set. */
    async listForNodeExcept(
        nodeId: string,
        keepIds: readonly string[],
    ): Promise<FleetActionsRunner[]> {
        if (!UUID.test(nodeId)) return [];
        const keep = keepIds.filter((id) => UUID.test(id));
        return this.repository.find({
            where:
                keep.length > 0
                    ? { nodeId, removedAt: IsNull(), id: Not(In(keep)) }
                    : { nodeId, removedAt: IsNull() },
        });
    }
}
