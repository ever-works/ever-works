import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { WorkBudgetAlertStateRepository } from '@src/database/repositories/work-budget-alert-state.repository';
import { BudgetOwnerType } from '@src/entities/_types';
import { WorkBudget, WorkBudgetScope } from '@src/entities/work-budget.entity';
import { WorkBudgetAlertThreshold } from '@src/entities/work-budget-alert-state.entity';
import { BudgetService, BudgetEvaluation, type BudgetOwnerRef } from './budget.service';
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
        options: {
            estimatedCostCents?: number;
            now?: Date;
            /**
             * Phase 7 PR T — when set, the cap-check resolves
             * budgets via the polymorphic owner ref (e.g.
             * `{ ownerType: 'mission', ownerId: missionId }`) so
             * a Mission's per-Mission budget guards plugin calls
             * spawned for that Mission. When omitted, falls back
             * to the legacy `workId`-keyed lookup — every existing
             * caller keeps working unchanged (NN #20).
             */
            owner?: BudgetOwnerRef;
        } = {},
    ): Promise<void> {
        const now = options.now ?? new Date();
        const estimatedCostCents = Math.max(0, Math.round(options.estimatedCostCents ?? 0));

        const { global, plugin } = options.owner
            ? await this.budgetService.getApplicableBudgetsForOwner(options.owner, pluginId)
            : await this.budgetService.getApplicableBudgets(workId, pluginId);

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

        // Post-flight: a previous call already pushed spend to or past the cap.
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

        // Pre-flight: this call's estimated max cost would push us past the
        // cap on a budget that doesn't allow overage. Block before invoking
        // the plugin so a single expensive request can't blow the cap by
        // an order of magnitude.
        if (estimatedCostCents > 0) {
            const preflightBlocking = evaluations.find(
                (e) =>
                    !e.budget.allowOverage && e.currentSpendCents + estimatedCostCents > e.capCents,
            );
            if (preflightBlocking) {
                throw new BudgetExceededException({
                    workId,
                    scope: preflightBlocking.budget.scope as WorkBudgetScope,
                    pluginId: preflightBlocking.budget.pluginId,
                    currentSpendCents: preflightBlocking.currentSpendCents,
                    capCents: preflightBlocking.capCents,
                    currency: preflightBlocking.budget.currency,
                });
            }
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
                // Single atomic write decides whether this caller owns the
                // alert for this (budget, threshold, period). The previous
                // version had a hasAlerted() pre-check that opened a race
                // window between two concurrent capability calls; relying on
                // the unique index closes it.
                const { inserted } = await this.alertStateRepository.record(
                    evaluation.budget.workId,
                    evaluation.budget.id,
                    threshold,
                    periodStart,
                );

                if (!inserted) continue;

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
                // Real failure (DB down, permission, etc.). Duplicates are
                // handled inside record() and return `inserted: false`.
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
