import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { DomainEvent } from '../entities/domain-event.entity';
import { DomainEventRelayState } from '../entities/domain-event-relay-state.entity';
import { Organization } from '../entities/organization.entity';
import { PluginEventCursor } from '../entities/plugin-event-cursor.entity';
import { Task } from '../entities/task.entity';
import { Team } from '../entities/team.entity';
import { Tenant } from '../entities/tenant.entity';
import { Work } from '../entities/work.entity';
import { DomainEventFeedService } from './domain-event-feed.service';
import { DomainEventPublisher } from './domain-event-publisher.service';
import { DomainEventRecorder } from './domain-event-recorder.service';

/**
 * Domain events — recording side (EW-P1-1).
 *
 * Import it wherever a service records events: it provides the
 * {@link DomainEventRecorder} (write the outbox row inside the caller's
 * transaction), the {@link DomainEventPublisher} (version bump + snapshot +
 * record at a recording point) and the {@link DomainEventFeedService} (read
 * the change feed).
 * It starts nothing: the relay lives in {@link DomainEventsRelayModule}, which
 * only the API process imports, so a worker that records events never relays.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([
            DomainEvent,
            DomainEventRelayState,
            PluginEventCursor,
            Tenant,
            Task,
            Team,
            Agent,
            Work,
            Organization,
        ]),
    ],
    providers: [DomainEventRecorder, DomainEventFeedService, DomainEventPublisher],
    exports: [DomainEventRecorder, DomainEventFeedService, DomainEventPublisher],
})
export class DomainEventsModule {}
