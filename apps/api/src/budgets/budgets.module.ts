import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BudgetsModule as AgentBudgetsModule } from '@ever-works/agent/budgets';
import { NotificationsModule as AgentNotificationsModule } from '@ever-works/agent/notifications';
import { DatabaseModule } from '@ever-works/agent/database';
import { User, Work } from '@ever-works/agent/entities';
import { MailModule } from '@src/mail/mail.module';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { BudgetAlertHandler } from './budget-alert.handler';
import { UsageController } from './usage.controller';
import { BudgetsController } from './budgets.controller';
import { AdminUsageController } from './admin-usage.controller';
import { PluginUsageCleanupService } from './plugin-usage-cleanup.service';

/**
 * EW-602 — apps/api glue for the budget enforcement layer. Imports the
 * agent's BudgetsModule (BudgetService + BudgetGuardService) so other
 * API modules can inject them, plus wires up the BudgetAlertHandler
 * which subscribes to BudgetThresholdCrossedEvent and dispatches the
 * in-app notification, email, and PostHog event.
 *
 * Also exposes the UsageController:
 *   GET /api/works/:workId/usage/summary[?period=current|YYYY-MM]
 *   GET /api/works/:workId/usage/trend[?period=...&granularity=day]
 * Backed by PluginUsageRepository aggregations + BudgetService period
 * helpers; access checked against work.userId / WorkMember.
 */
@Module({
    imports: [
        DatabaseModule,
        AgentBudgetsModule,
        AgentNotificationsModule,
        MailModule,
        TypeOrmModule.forFeature([User, Work]),
    ],
    controllers: [UsageController, BudgetsController, AdminUsageController],
    providers: [BudgetAlertHandler, PluginUsageCleanupService, DistributedTaskLockService],
    exports: [AgentBudgetsModule],
})
export class BudgetsModule {}
