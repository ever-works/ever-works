import { Module, type OnApplicationBootstrap, type OnModuleDestroy, Logger } from '@nestjs/common';
import { DomainEventsModule } from './domain-events.module';
import { DomainEventPluginDeliveryService } from './domain-event-plugin-delivery.service';
import { DomainEventRelayService } from './domain-event-relay.service';
import { DomainEventRetentionService } from './domain-event-retention.service';
import { DomainEventWorkBridge } from './domain-event-work-bridge';

/**
 * Domain events — relay side (EW-P1-1). Imported by the API process ONLY.
 *
 * Starts the {@link DomainEventRelayService} on application bootstrap (one
 * leader across replicas via the DB lease) and stops it on shutdown, releasing
 * the lease so another replica takes over at once. `DOMAIN_EVENTS_RELAY_ENABLED=false`
 * keeps it stopped; events then wait in the outbox. Under `NODE_ENV=test` the
 * relay is not started automatically — tests drive `tick()` themselves.
 *
 * `PluginRegistryService` is optional here: where the plugin system is wired
 * (the API), subscriber plugins receive events; elsewhere plugin delivery is
 * a no-op.
 */
@Module({
    imports: [DomainEventsModule],
    providers: [
        DomainEventRelayService,
        DomainEventRetentionService,
        DomainEventPluginDeliveryService,
        // Existing `work.created` / `work.status.changed` events → `work.*` domain events.
        DomainEventWorkBridge,
    ],
    exports: [DomainEventRelayService],
})
export class DomainEventsRelayModule implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(DomainEventsRelayModule.name);

    constructor(private readonly relay: DomainEventRelayService) {}

    async onApplicationBootstrap(): Promise<void> {
        if (process.env.NODE_ENV === 'test') return;
        try {
            await this.relay.start();
        } catch (error) {
            this.logger.error(
                `Domain event relay did not start: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async onModuleDestroy(): Promise<void> {
        await this.relay.stop();
    }
}
