import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AgentsModule } from '../agents/agents.module';
import { RunLedgerModule } from '../agents/run-ledger.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { DatabaseModule } from '../database/database.module';
import { InboxModule } from '../inbox/inbox.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WorkAgentModule } from '../work-agent/work-agent.module';
import { HomeActivityBuilder } from './builders/activity.builder';
import { HomeDecisionsBuilder } from './builders/decisions.builder';
import { HomeRunsBuilder } from './builders/runs.builder';
import { HomeSpendBuilder } from './builders/spend.builder';
import { HomeTodayBuilder } from './builders/today.builder';
import { HomeSummaryService } from './home-summary.service';

/**
 * Home (AW-19) — the read-only composition module behind the morning read.
 *
 * It adds no entity and no write path. Each import is the module that
 * already owns one source, and each is imported one-way (none of them
 * imports Home back):
 *
 * - `InboxModule` — the My Decisions queue (`InboxService`, `InboxItemRepository`).
 * - `RunLedgerModule` + `AgentsModule` — the Runs ledger and the run repository.
 * - `SchedulesModule` — the schedule aggregation.
 * - `SubscriptionsModule` + `BudgetsModule` + `WorkAgentModule` — the Costs
 *   summary, the account-wide budget summary and the cap preferences.
 * - `ActivityLogModule` — the Live Feed.
 * - `DatabaseModule` — the usage and notification-preference repositories.
 *
 * Every builder's source is injected `@Optional()`: a deployment that does
 * not wire one reports that block as unavailable instead of failing to boot
 * or hiding the gap behind an empty block.
 */
@Module({
    imports: [
        DatabaseModule,
        InboxModule,
        AgentsModule,
        RunLedgerModule,
        SchedulesModule,
        SubscriptionsModule,
        BudgetsModule,
        WorkAgentModule,
        ActivityLogModule,
    ],
    providers: [
        HomeDecisionsBuilder,
        HomeRunsBuilder,
        HomeTodayBuilder,
        HomeSpendBuilder,
        HomeActivityBuilder,
        HomeSummaryService,
    ],
    exports: [HomeSummaryService],
})
export class HomeModule {}
