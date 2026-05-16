import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { WorkBudget, WorkBudgetScope } from '@src/entities/work-budget.entity';

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
