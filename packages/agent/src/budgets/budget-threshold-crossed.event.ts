import type { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import type { WorkBudget } from '@src/entities/work-budget.entity';
import type { WorkBudgetAlertThreshold } from '@src/entities/work-budget-alert-state.entity';

/**
 * EW-602 — Fired by BudgetGuardService when current-period spend crosses
 * a configured threshold (75% / 90% / 100% / overage). Phase 2c handlers
 * subscribe via `@OnEvent(BudgetThresholdCrossedEvent.EVENT_NAME)` to:
 *   - create an in-app NotificationService entry (category 'ai_credits')
 *   - send a templated email via MailService (budget-alert.hbs)
 *   - emit a PostHog `budget_threshold_crossed` analytics event
 *
 * Idempotency is enforced upstream via WorkBudgetAlertStateRepository,
 * so handlers can dispatch unconditionally.
 */
export class BudgetThresholdCrossedEvent {
    static readonly EVENT_NAME = 'budget.threshold-crossed';

    constructor(
        public readonly workId: string,
        public readonly userId: string,
        public readonly budget: WorkBudget,
        public readonly threshold: WorkBudgetAlertThreshold,
        public readonly currentSpendCents: number,
        public readonly capCents: number,
        public readonly currency: string,
        public readonly capability: PluginUsageCapability,
        public readonly periodStart: Date,
        public readonly pluginId?: string,
    ) {}
}
