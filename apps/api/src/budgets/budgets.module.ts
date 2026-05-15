import { Module } from '@nestjs/common';
import { BudgetsModule as AgentBudgetsModule } from '@ever-works/agent/budgets';
import { NotificationsModule as AgentNotificationsModule } from '@ever-works/agent/notifications';
import { DatabaseModule } from '@ever-works/agent/database';
import { MailModule } from '@src/mail/mail.module';
import { BudgetAlertHandler } from './budget-alert.handler';

/**
 * EW-602 — apps/api glue for the budget enforcement layer. Imports the
 * agent's BudgetsModule (BudgetService + BudgetGuardService) so other
 * API modules can inject them, plus wires up the BudgetAlertHandler
 * which subscribes to BudgetThresholdCrossedEvent and dispatches the
 * in-app notification, email, and PostHog event.
 */
@Module({
    imports: [DatabaseModule, AgentBudgetsModule, AgentNotificationsModule, MailModule],
    providers: [BudgetAlertHandler],
    exports: [AgentBudgetsModule],
})
export class BudgetsModule {}
