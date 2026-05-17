import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import {
    WorkBudgetAlertState,
    WorkBudgetAlertThreshold,
} from '@src/entities/work-budget-alert-state.entity';

export interface AlertRecordResult {
    /** True when this call inserted a new row; false when a row already existed. */
    readonly inserted: boolean;
}

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
     * Atomically inserts an alert-state row. The unique index on
     * (budgetId, threshold, periodStart) is the dedupe authority — two
     * concurrent callers race the insert, only one wins, and the loser
     * gets `inserted: false`. Callers use that signal to decide whether
     * to fire the user-facing alert exactly once per (budget, threshold,
     * period).
     */
    async record(
        workId: string,
        budgetId: string,
        threshold: WorkBudgetAlertThreshold,
        periodStart: Date,
    ): Promise<AlertRecordResult> {
        try {
            await this.repository.insert({ workId, budgetId, threshold, periodStart });
            return { inserted: true };
        } catch (error) {
            if (isUniqueConstraintViolation(error)) {
                return { inserted: false };
            }
            throw error;
        }
    }

    async listForBudget(budgetId: string): Promise<WorkBudgetAlertState[]> {
        return this.repository.find({
            where: { budgetId },
            order: { periodStart: 'DESC', threshold: 'ASC' },
        });
    }
}

function isUniqueConstraintViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = (error as QueryFailedError & { driverError?: { code?: string } })
        .driverError;
    const code = driverError?.code ?? '';
    // 23505 = Postgres unique_violation; SQLITE_CONSTRAINT* covers
    // better-sqlite3 in CI. Message fallback handles drivers that don't
    // expose a code (e.g. some test doubles).
    if (code === '23505' || code.startsWith('SQLITE_CONSTRAINT')) return true;
    return /unique constraint/i.test(error.message ?? '');
}
