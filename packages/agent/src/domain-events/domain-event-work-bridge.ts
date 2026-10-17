import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkCreatedEvent } from '../events/work-created.event';
import { WorkStatusChangedEvent } from '../events/work-status-changed.event';
import { DomainEventPublisher, recordAfterWrite } from './domain-event-publisher.service';

/**
 * Domain events (EW-P1-1 B2) — turns the platform's existing Work lifecycle
 * events into `work.*` domain events.
 *
 * Every Work create path (the lifecycle service and the App Work create)
 * already emits `work.created` after its write commits, and every lifecycle
 * status change emits `work.status.changed`; listening here covers them all
 * without touching each path. Recorded in a transaction of its own right after
 * the write (best-effort, see `recordAfterWrite`).
 *
 * Provided by the API-only relay module, where those events are emitted.
 */
@Injectable()
export class DomainEventWorkBridge {
    private readonly logger = new Logger(DomainEventWorkBridge.name);

    constructor(@Optional() private readonly publisher?: DomainEventPublisher) {}

    @OnEvent(WorkCreatedEvent.EVENT_NAME, { async: true })
    async onWorkCreated(event: WorkCreatedEvent): Promise<void> {
        const workId = event?.work?.id;
        if (!workId) return;
        await recordAfterWrite(
            this.publisher,
            (publisher, manager) =>
                publisher.created(manager, 'work', workId, 'work.created', {
                    actor: event.work.userId
                        ? { type: 'user', id: event.work.userId, label: null }
                        : undefined,
                }),
            (message) => this.logger.warn(message),
            `work.created for ${workId}`,
        );
    }

    @OnEvent(WorkStatusChangedEvent.EVENT_NAME, { async: true })
    async onWorkStatusChanged(event: WorkStatusChangedEvent): Promise<void> {
        if (!event?.workId) return;
        const type = event.newStatus === 'archived' ? 'work.archived' : 'work.updated';
        await recordAfterWrite(
            this.publisher,
            (publisher, manager) =>
                publisher.changed(manager, 'work', event.workId, type, {
                    changedFields: ['status'],
                    previous: { status: event.previousStatus },
                }),
            (message) => this.logger.warn(message),
            `${type} for ${event.workId}`,
        );
    }
}
