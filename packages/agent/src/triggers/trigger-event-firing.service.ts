import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { EventIngestService } from '../ingest/event-ingest.service';
import type { IngestedEvent } from '../entities/ingested-event.entity';
import { InboundTriggersService } from './inbound-triggers.service';

/**
 * Bridge between the ingest spine and event-sourced inbound triggers.
 *
 * Registers a WILDCARD kind processor (`kinds: ['*']`) on
 * `EventIngestService` at boot — the same seam Meetings uses for
 * `zoom.recording`, widened because triggers match by user-authored
 * `eventMatcher` rules, not a fixed kind list.
 *
 * Kind processors are REQUIRED-grade in the drain (a throw leaves the
 * row unprocessed for retry), and `fireForEvent` leans into that
 * deliberately:
 *   - per-trigger failures are swallowed inside `fireForEvent` (one
 *     broken rule can never block the Activity fan-out), while
 *   - an infrastructure failure (the trigger query itself dying)
 *     bubbles, the row retries next tick, and the `(trigger, event)`
 *     claim ledger keeps the retry from double-firing anything that
 *     already fired.
 *
 * `EventIngestService` is `@Optional()` so the triggers module keeps
 * working in contexts that do not mount the ingest spine.
 */
@Injectable()
export class TriggerEventFiringService implements OnModuleInit {
    private readonly logger = new Logger(TriggerEventFiringService.name);

    constructor(
        private readonly triggers: InboundTriggersService,
        @Optional() private readonly eventIngest?: EventIngestService,
    ) {}

    onModuleInit(): void {
        if (!this.eventIngest) {
            this.logger.debug(
                'Event-ingest spine not mounted — event-sourced triggers will not fire here.',
            );
            return;
        }
        this.eventIngest.registerKindProcessor({
            kinds: ['*'],
            process: (event: IngestedEvent) => this.process(event),
        });
    }

    private async process(event: IngestedEvent): Promise<void> {
        const { fired, deduped, failed } = await this.triggers.fireForEvent(event);
        if (fired > 0 || deduped > 0 || failed > 0) {
            this.logger.log(
                `Event ${event.id} (${event.kind}): ${fired} trigger(s) fired, ${deduped} deduped, ${failed} failed.`,
            );
        }
    }
}
