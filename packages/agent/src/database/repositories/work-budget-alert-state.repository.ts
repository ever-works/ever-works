import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    WorkBudgetAlertState,
    WorkBudgetAlertThreshold,
} from '@src/entities/work-budget-alert-state.entity';

@Injectable()
export class WorkBudgetAlertStateRepository {
    constructor(
        @InjectRepository(WorkBudgetAlertState)
        private readonly repository: Repository<WorkBudgetAlertState>,
    ) {}

    async hasAlerted(
        budgetId: string,
        threshold: WorkBudgetAlertThreshold,
        periodStart: Date,
    ): Promise<boolean> {
        const count = await this.repository.count({
            where: { budgetId, threshold, periodStart },
        });
        return count > 0;
    }

    /**
     * Inserts an alert-state row. Idempotent — duplicates throw the
     * unique-constraint error which the caller can swallow.
     */
    async record(
        workId: string,
        budgetId: string,
        threshold: WorkBudgetAlertThreshold,
        periodStart: Date,
    ): Promise<WorkBudgetAlertState> {
        const created = this.repository.create({
            workId,
            budgetId,
            threshold,
            periodStart,
        });
        return this.repository.save(created);
    }

    async listForBudget(budgetId: string): Promise<WorkBudgetAlertState[]> {
        return this.repository.find({
            where: { budgetId },
            order: { periodStart: 'DESC', threshold: 'ASC' },
        });
    }
}
