import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AgentRepository } from '../database/repositories/agent.repository';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { EventIngestModule } from '../ingest/ingest.module';
import { WebhookSubscriptionSecretService } from '../services/webhook-subscription-secret.service';
import { InboundTriggersService } from './inbound-triggers.service';
import { InboundTriggerFireRepository } from './inbound-trigger-fire.repository';
import { TriggerEventFiringService } from './trigger-event-firing.service';

/**
 * Inbound Triggers ("Trigger Schedules") — agent-side module.
 *
 * - `DatabaseModule` exports `TypeOrmModule.forFeature(ENTITIES)`, which
 *   registers every entity's TypeORM repository token (`InboundTrigger`,
 *   `Agent`, …) — but NOT the hand-rolled custom repositories.
 * - `AgentRepository` (a custom repository injected by `InboundTriggersService`
 *   for targetAgentId ownership checks) is therefore provided locally; it
 *   only needs `@InjectRepository(Agent)`, which `DatabaseModule` supplies.
 *   Same pattern as `AgentsModule`. Without this the app fails to boot with
 *   "Nest can't resolve dependencies of InboundTriggersService … AgentRepository".
 * - `TasksModule` (tasks-domain) provides `TasksService`, the canonical
 *   programmatic Task-creation path — a verified fire spawns a Task
 *   through the exact same code every other surface uses.
 * - `WebhookSubscriptionSecretService` is dependency-free, so it is
 *   provided locally (same wiring the Trigger.dev webhook-delivery
 *   module uses) rather than dragging in a broader services module.
 * - `EventIngestModule` supplies `EventIngestService` so
 *   `TriggerEventFiringService` can register the wildcard kind
 *   processor that fires event-sourced triggers from the ingest drain
 *   (same registration seam Meetings uses).
 * - `InboundTriggerFireRepository` is the feature-owned `(trigger,
 *   event)` claim ledger backing fire idempotency; its entity's TypeORM
 *   token comes from `DatabaseModule`'s `forFeature(ENTITIES)`.
 */
@Module({
    imports: [DatabaseModule, TasksDomainModule, EventIngestModule],
    providers: [
        InboundTriggersService,
        WebhookSubscriptionSecretService,
        AgentRepository,
        InboundTriggerFireRepository,
        TriggerEventFiringService,
    ],
    exports: [InboundTriggersService],
})
export class InboundTriggersModule {}
