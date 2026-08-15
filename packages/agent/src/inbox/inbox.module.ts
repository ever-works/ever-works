import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxItem } from '../entities/inbox-item.entity';
import { InboxItemRepository } from '../database/repositories/inbox-item.repository';
import { AgentsModule } from '../agents/agents.module';
import { AgentApprovalsModule } from '../agent-approvals/agent-approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { InboxService } from './inbox.service';
import { InboxBudgetAlertListener } from './inbox-budget-alert.listener';

/**
 * Inbox (operator message center) — the agent-side module owning the
 * `inbox_items` surface. The api-side `apps/api/src/inbox/InboxModule`
 * imports this one, mounts the controller and binds the
 * `INBOX_PRODUCER` token (so the escalation / approval / budget
 * producers — all `@Optional()` consumers of that token — actually
 * fire in production).
 *
 * `InboxBudgetAlertListener` is provided here rather than in
 * `BudgetsModule`: the listener depends on `InboxService`, and the
 * budgets layer must stay unaware of the inbox (the guard sits on the
 * hot capability path). Nest instantiates it as soon as this module is
 * imported anywhere, which is what registers the `@OnEvent` handler.
 *
 * `InboxItem` MUST also stay registered in the DataSource ENTITIES
 * array (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 *
 * Import direction is one-way by construction: this module imports
 * agents / agent-approvals / notifications, and none of them imports
 * it back — their only reach into the inbox is the leaf
 * `inbox-producer.port.ts` token file.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([InboxItem]),
        // RunSteeringService (question replies steer/resume runs) +
        // AgentRunRepository (askHuman parks the asking run) +
        // AgentEscalationService (escalation replies resolve).
        AgentsModule,
        // Approval replies proxy to the decide path.
        AgentApprovalsModule,
        // Bell row + notifications-v2 channel fanout on item create.
        NotificationsModule,
        // INBOX_ITEM_CREATED / INBOX_ITEM_ANSWERED activity rows.
        ActivityLogModule,
    ],
    providers: [InboxItemRepository, InboxService, InboxBudgetAlertListener],
    exports: [InboxItemRepository, InboxService],
})
export class InboxModule {}
