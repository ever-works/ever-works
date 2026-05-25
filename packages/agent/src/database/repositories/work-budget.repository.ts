import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { BudgetOwnerType } from '@src/entities/_types';
import { WorkBudget, WorkBudgetScope } from '@src/entities/work-budget.entity';

/**
 * Phase 7 PR T — owner ref used by the polymorphic budget
 * lookup methods (`findGlobalForOwner` + `findForOwnerPlugin`).
 * Existing `findGlobal(workId)` + `findForPlugin(workId, pluginId)`
 * keep working as Work-scoped back-compat helpers (NN #20).
 */
export interface BudgetOwnerRef {
    ownerType: BudgetOwnerType;
    ownerId: string;
}

@Injectable()
export class WorkBudgetRepository {
    constructor(
        @InjectRepository(WorkBudget)
        private readonly repository: Repository<WorkBudget>,
    ) {}

    async findAllForWork(workId: string): Promise<WorkBudget[]> {
        return this.repository.find({
            where: { workId },
            order: { scope: 'ASC', pluginId: 'ASC' },
        });
    }

    async findGlobal(workId: string): Promise<WorkBudget | null> {
        return this.repository.findOne({
            where: { workId, scope: WorkBudgetScope.GLOBAL, pluginId: IsNull() },
        });
    }

    async findForPlugin(workId: string, pluginId: string): Promise<WorkBudget | null> {
        return this.repository.findOne({
            where: { workId, scope: WorkBudgetScope.PLUGIN, pluginId },
        });
    }

    /**
     * Phase 7 PR T — polymorphic GLOBAL-budget lookup. Used by the
     * new `BudgetGuardService.checkBudgetForOwner` overload so the
     * cap-check path can scope to a Mission or Idea (not just the
     * implicit Work owner). For back-compat the legacy
     * `findGlobal(workId)` keeps querying via `workId` only —
     * existing Work-budget rows have `ownerType='work'` +
     * `ownerId=workId` from the PR 0.3 backfill, so a lookup via
     * either path resolves to the same row.
     */
    async findGlobalForOwner(owner: BudgetOwnerRef): Promise<WorkBudget | null> {
        return this.repository.findOne({
            where: {
                ownerType: owner.ownerType,
                ownerId: owner.ownerId,
                scope: WorkBudgetScope.GLOBAL,
                pluginId: IsNull(),
            },
        });
    }

    /**
     * Phase 7 PR T — polymorphic PLUGIN-scope budget lookup.
     * Mirrors `findForPlugin(workId, pluginId)` but keyed on the
     * polymorphic owner ref.
     */
    async findForOwnerPlugin(owner: BudgetOwnerRef, pluginId: string): Promise<WorkBudget | null> {
        return this.repository.findOne({
            where: {
                ownerType: owner.ownerType,
                ownerId: owner.ownerId,
                scope: WorkBudgetScope.PLUGIN,
                pluginId,
            },
        });
    }

    async findById(id: string): Promise<WorkBudget | null> {
        return this.repository.findOne({ where: { id } });
    }

    async create(input: Partial<WorkBudget>): Promise<WorkBudget> {
        const created = this.repository.create(input);
        return this.repository.save(created);
    }

    async update(id: string, patch: Partial<WorkBudget>): Promise<WorkBudget | null> {
        await this.repository.update({ id }, patch);
        return this.findById(id);
    }

    async delete(id: string): Promise<void> {
        await this.repository.delete({ id });
    }
}
