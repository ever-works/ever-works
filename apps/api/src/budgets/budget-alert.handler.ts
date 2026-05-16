import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AnalyticsService } from '@ever-works/monitoring';
import { NotificationService } from '@ever-works/agent/notifications';
import { BudgetThresholdCrossedEvent } from '@ever-works/agent/budgets';
import { UserRepository } from '@ever-works/agent/database';
import { config } from '@src/config/constants';
import { MailService } from '@src/mail/mail.service';

/**
 * EW-602 — Subscribes to BudgetThresholdCrossedEvent and fans out:
 *   1. In-app notification (NotificationService)
 *   2. Email (MailService.sendBudgetAlertEmail)
 *   3. PostHog analytics event
 *
 * Idempotency for (1) and (2) is guarded upstream by
 * WorkBudgetAlertStateRepository in BudgetGuardService — handlers can
 * dispatch unconditionally.
 *
 * Email opt-out: gated by `User.emailBudgetAlerts` (added in a later
 * sub-phase). Until then all users with an email receive alerts.
 */
@Injectable()
export class BudgetAlertHandler {
    private readonly logger = new Logger(BudgetAlertHandler.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly notificationService: NotificationService,
        private readonly mailService: MailService,
        @Optional() private readonly analytics?: AnalyticsService,
    ) {}

    @OnEvent(BudgetThresholdCrossedEvent.EVENT_NAME)
    async handle(event: BudgetThresholdCrossedEvent): Promise<void> {
        try {
            await this.notificationService.notifyBudgetThresholdCrossed({
                userId: event.userId,
                workId: event.workId,
                budgetId: event.budget.id,
                threshold: event.threshold,
                scope: event.budget.scope,
                pluginId: event.budget.pluginId,
                currentSpendCents: event.currentSpendCents,
                capCents: event.capCents,
                currency: event.currency,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to create in-app notification for budget alert (budget=${event.budget.id}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        try {
            this.analytics?.track(event.userId, 'budget_threshold_crossed', {
                workId: event.workId,
                budgetId: event.budget.id,
                threshold: event.threshold,
                scope: event.budget.scope,
                pluginId: event.budget.pluginId,
                capability: event.capability,
                currentSpendCents: event.currentSpendCents,
                capCents: event.capCents,
                currency: event.currency,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to emit analytics event for budget alert (budget=${event.budget.id}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        try {
            const user = await this.userRepository.findById(event.userId);
            if (!user) {
                this.logger.warn(`Budget alert: user ${event.userId} not found — skipping email`);
                return;
            }
            if (!user.email) {
                return;
            }
            if (user.emailBudgetAlerts === false) {
                this.logger.debug(
                    `Budget alert: user ${event.userId} opted out of budget-alert emails — skipping send`,
                );
                return;
            }

            const periodLabel = event.periodStart.toLocaleString('en-US', {
                month: 'long',
                year: 'numeric',
            });
            const scopeLabel =
                event.budget.scope === 'plugin' && event.budget.pluginId
                    ? `plugin '${event.budget.pluginId}'`
                    : 'directory-wide';
            // EW-602 review fix (Greptile P1): budgets settings page lives at
            // /works/:workId/settings/budgets-usage (per-Work), not the
            // per-User /settings namespace. A bare /settings/budgets-usage
            // link in the email leads to a 404.
            const settingsUrl = `${config.webAppUrl()}/works/${event.workId}/settings/budgets-usage`;

            await this.mailService.sendBudgetAlertEmail(user.email, user.username ?? 'there', {
                workName: event.budget.work?.name ?? event.workId,
                scopeLabel,
                pluginId: event.budget.pluginId,
                capability: event.capability,
                threshold: event.threshold,
                currentSpendCents: event.currentSpendCents,
                capCents: event.capCents,
                currency: event.currency,
                periodLabel,
                settingsUrl,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to send budget-alert email (budget=${event.budget.id}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
