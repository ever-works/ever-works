import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import {
    type EmailMessageChange,
    EmailMessageRepository,
} from '../database/repositories/email-message.repository';
import { EmailMessage } from '../entities/email-message.entity';
import {
    DomainEventPublisher,
    recordAfterWrite,
} from '../domain-events/domain-event-publisher.service';
import { DomainEventsModule } from '../domain-events/domain-events.module';

/**
 * EW-P4-2 — records `email.message.*` domain events.
 *
 * `EmailMessageRepository` is the single writer of `email_messages` (the
 * inbound dispatcher, the draft loop, the send-policy reservation, provider
 * delivery events, the Task link all go through it) and reports every write
 * after it lands; this bridge turns each report into an event, in a
 * transaction of its own (best-effort, like the other non-transactional
 * recording points: a failure is logged, never thrown into the mail path):
 *
 * - a new inbound row → `email.message.received`;
 * - a new outbound row already `sent`, or a status move to `sent` →
 *   `email.message.sent`;
 * - any other change (a draft filed, `sending`, `failed`, `discarded`, a
 *   delivery status, the Task link) → `email.message.status_changed`.
 *
 * The events are recipient-scoped (`email:read`), see
 * `buildEmailMessageSnapshot`. A message outside any organization records
 * nothing.
 */
@Injectable()
export class EmailMessageDomainEventsBridge implements OnModuleInit {
    private readonly logger = new Logger(EmailMessageDomainEventsBridge.name);

    constructor(
        private readonly messages: EmailMessageRepository,
        private readonly publisher: DomainEventPublisher,
    ) {}

    onModuleInit(): void {
        this.messages.setChangeListener((change) => this.record(change));
    }

    async record(change: EmailMessageChange): Promise<void> {
        await recordAfterWrite(
            this.publisher,
            async (publisher, manager) => {
                if (change.kind === 'created') {
                    const row = await manager.getRepository(EmailMessage).findOne({
                        where: { id: change.id },
                        select: ['id', 'direction', 'status'],
                    });
                    if (!row) return;
                    const type =
                        row.direction === 'inbound'
                            ? 'email.message.received'
                            : row.status === 'sent'
                              ? 'email.message.sent'
                              : 'email.message.status_changed';
                    await publisher.created(manager, 'email_message', change.id, type);
                    return;
                }
                await publisher.changed(
                    manager,
                    'email_message',
                    change.id,
                    change.to === 'sent' ? 'email.message.sent' : 'email.message.status_changed',
                    {
                        changedFields: [...new Set(change.changedFields)],
                        previous: { ...change.previous },
                    },
                );
            },
            (message) => this.logger.warn(message),
            `email.message.* for ${change.id}`,
        );
    }
}

/**
 * EW-P4-2 — wires {@link EmailMessageDomainEventsBridge} (imported by the API's
 * email module, where provider webhooks, sends and the draft loop run).
 */
@Module({
    imports: [DatabaseModule, DomainEventsModule],
    providers: [EmailMessageDomainEventsBridge],
    exports: [EmailMessageDomainEventsBridge],
})
export class EmailDomainEventsModule {}
