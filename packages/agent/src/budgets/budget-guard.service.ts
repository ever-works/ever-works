import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { WorkBudgetAlertStateRepository } from '@src/database/repositories/work-budget-alert-state.repository';
import {
    WorkBudget,
    WorkBudgetScope,
} from '@src/entities/work-budget.entity';
import { WorkBudgetAlertThreshold } from '@src/entities/work-budget-alert-state.entity';
import { BudgetService, BudgetEvaluation } from './budget.service';
import { BudgetExceededException } from './budget-exceeded.exception';
import { BudgetThresholdCrossedEvent } from './budget-threshold-crossed.event';

/**
 * EW-602 — The enforcement gate. Called at the top of each capability
 * facade method (AI / Search / Screenshot / Extractor) before the
 * underlying plugin invocation.
 *
 * Behaviour:
 *   1. Resolve global + plugin-scoped budgets for (workId, pluginId).
 *   2. For each, compute current-period spend and cross-check thresholds.
 *   3. Fire BudgetThresholdCrossedEvent for any newly-crossed threshold
 *      (idempotency guarded by WorkBudgetAlertStateRepository).
 *   4. If any budget is blocked (≥ 100% with allowOverage=false), throw
 *      BudgetExceededException — the call never reaches the plugin.
 *
 * Best-effort on alert dispatch: a failed alert write must not block
 * the call, but a `blocked` evaluation always raises the exception.
 */
@Injectable()
export class BudgetGuardService {
    private readonly logger = new Logger(BudgetGuardService.name);

    constructor(
        private readonly budgetService: BudgetService,
        private readonly alertStateRepository: WorkBudgetAlertStateRepository,
        @Optional() private readonly eventEmitter?: EventEmitter2,
    ) {}

    async checkBudget(
        workId: string,
        userId: string,
        capability: PluginUsageCapability,
        pluginId: string,
        now: Date = new Date(),
    ): Promise<void> {
        const { global, plugin } = await this.budgetService.getApplicableBudgets(
            workId,
            pluginId,
        );

        const evaluations: BudgetEvaluation[] = [];
        if (global) {
            evaluations.push(await this.budgetService.evaluateBudget(global, now));
        }
        if (plugin) {
            evaluations.push(await this.budgetService.evaluateBudget(plugin, now));
        }

        if (evaluations.length === 0) {
            return;
        }

        const periodStart = this.budgetService.getCurrentPeriodStart(now);

        for (const evaluation of evaluations) {
            await this.dispatchAlertsForCrossedThresholds(
                evaluation,
                userId,
                capability,
                periodStart,
                pluginId,
            );
        }

        const blocking = evaluations.find((e) => e.blocked);
        if (blocking) {
            throw new BudgetExceededException({
                workId,
                scope: blocking.budget.scope as WorkBudgetScope,
                pluginId: blocking.budget.pluginId,
                currentSpendCents: blocking.currentSpendCents,
                capCents: blocking.capCents,
                currency: blocking.budget.currency,
            });
        }
    }

    private async dispatchAlertsForCrossedThresholds(
        evaluation: BudgetEvaluation,
        userId: string,
        capability: PluginUsageCapability,
        periodStart: Date,
        pluginId: string,
    ): Promise<void> {
        for (const threshold of evaluation.crossedThresholds) {
            try {
                const alreadySent = await this.alertStateRepository.hasAlerted(
                    evaluation.budget.id,
                    threshold,
                    periodStart,
                );
                if (alreadySent) continue;

                await this.alertStateRepository.record(
                    evaluation.budget.workId,
                    evaluation.budget.id,
                    threshold,
                    periodStart,
                );

                this.eventEmitter?.emit(
                    BudgetThresholdCrossedEvent.EVENT_NAME,
                    new BudgetThresholdCrossedEvent(
                        evaluation.budget.workId,
                        userId,
                        evaluation.budget,
                        threshold,
                        evaluation.currentSpendCents,
                        evaluation.capCents,
                        evaluation.budget.currency,
                        capability,
                        periodStart,
                        evaluation.budget.pluginId ?? pluginId,
                    ),
                );
            } catch (error) {
                this.logger.warn(
                    `Failed to dispatch budget alert (budget=${evaluation.budget.id}, threshold=${threshold}): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
    }
}

export { WorkBudgetAlertThreshold };
export type { WorkBudget };
