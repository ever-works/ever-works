import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DomainEventsModule, DomainEventsRelayModule } from '@ever-works/agent/domain-events';
import { DomainEventContextInterceptor } from './domain-event-context.interceptor';

/**
 * Domain events in the API process (EW-P1-1, `docs/specs/features/domain-events/spec.md`).
 *
 * - `DomainEventsModule` — the recorder and the feed reader.
 * - `DomainEventsRelayModule` — the single-leader relay (started on bootstrap,
 *   stopped on shutdown; `DOMAIN_EVENTS_RELAY_ENABLED=false` keeps it off).
 * - `DomainEventContextInterceptor` (global) — attributes every request's
 *   events to its principal and `X-Sync-Origin`.
 */
@Module({
    imports: [DomainEventsModule, DomainEventsRelayModule],
    providers: [{ provide: APP_INTERCEPTOR, useClass: DomainEventContextInterceptor }],
    exports: [DomainEventsModule],
})
export class DomainEventsApiModule {}
