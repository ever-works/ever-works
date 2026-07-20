import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { WebhookSubscriptionSecretService } from '../services/webhook-subscription-secret.service';
import { InboundTriggersService } from './inbound-triggers.service';

/**
 * Inbound Triggers ("Trigger Schedules") — agent-side module.
 *
 * - `DatabaseModule` exports `TypeOrmModule.forFeature(ENTITIES)` (which
 *   includes `InboundTrigger`) plus the repository inventory
 *   (`AgentRepository` for targetAgentId ownership checks).
 * - `TasksModule` (tasks-domain) provides `TasksService`, the canonical
 *   programmatic Task-creation path — a verified fire spawns a Task
 *   through the exact same code every other surface uses.
 * - `WebhookSubscriptionSecretService` is dependency-free, so it is
 *   provided locally (same wiring the Trigger.dev webhook-delivery
 *   module uses) rather than dragging in a broader services module.
 */
@Module({
    imports: [DatabaseModule, TasksDomainModule],
    providers: [InboundTriggersService, WebhookSubscriptionSecretService],
    exports: [InboundTriggersService],
})
export class InboundTriggersModule {}
