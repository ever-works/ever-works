import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { EmailMessageRepository } from '../../database/repositories/email-message.repository';
import { EmailMessageDomainEventsBridge } from '../../email/email-message-domain-events.bridge';
import { DomainEvent } from '../../entities/domain-event.entity';
import { EmailMessage } from '../../entities/email-message.entity';
import { Organization } from '../../entities/organization.entity';
import { EMAIL_EVENT_BODY_MAX_BYTES } from '../domain-event-email-snapshots';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Agent email recording points (EW-P4-2): the real `EmailMessageRepository`
 * (the single writer of `email_messages`) reporting to the real
 * `EmailMessageDomainEventsBridge` on SQLite. Each event's `data` is valid
 * against the schema its catalog row names (`resources/email-message.schema.json`),
 * and every event is recipient-scoped.
 */
describe('agent email recording points', () => {
    let dataSource: DataSource;
    let messages: EmailMessageRepository;
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const AGENT = randomUUID();
    const ADDRESS = randomUUID();

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        messages = new EmailMessageRepository(dataSource.getRepository(EmailMessage));
        const bridge = new EmailMessageDomainEventsBridge(
            messages,
            new DomainEventPublisher(new DomainEventRecorder(), dataSource),
        );
        bridge.onModuleInit();
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of ['email_messages', 'organizations']) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        await dataSource.getRepository(Organization).insert({
            id: ORG_A,
            tenantId: TENANT,
            slug: 'acme',
            displayName: 'Acme',
        } as unknown as Organization);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const message = (overrides: Partial<EmailMessage> = {}): EmailMessage =>
        ({
            userId: OWNER,
            agentId: AGENT,
            emailAddressId: ADDRESS,
            direction: 'inbound',
            pluginId: 'postmark',
            providerMessageId: randomUUID(),
            from: 'ada@example.com',
            toAddresses: ['support@acme.test'],
            ccAddresses: ['bob@example.com'],
            bccAddresses: ['hidden@example.com'],
            subject: 'Refund',
            bodyText: 'Can I get a refund?',
            bodyHtml: '<p>Can I get a refund?</p>',
            messageIdHeader: 'abc@example.com',
            receivedAt: new Date(),
            deliveryStatus: 'delivered',
            status: 'received',
            tenantId: TENANT,
            organizationId: ORG_A,
            ...overrides,
        }) as unknown as EmailMessage;

    it('a received message records email.message.received at version 1, recipient-scoped, never exposing Bcc', async () => {
        const saved = await messages.save(message());
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'email.message.received',
            aggregateType: 'email_message',
            aggregateId: saved.id,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
            visibility: 'recipient',
        });
        expect(event.data).toMatchObject({
            id: saved.id,
            ownerUserId: OWNER,
            agentId: AGENT,
            direction: 'inbound',
            status: 'received',
            to: ['support@acme.test'],
            cc: ['bob@example.com'],
            messageId: 'abc@example.com',
        });
        expect(JSON.stringify(event.data)).not.toContain('hidden@example.com');
        expectValid(event);
    });

    it('a draft that is sent records status_changed for the draft and sending, then sent', async () => {
        const draft = await messages.save(
            message({
                direction: 'outbound',
                status: 'draft',
                receivedAt: null,
                deliveryStatus: null,
            } as Partial<EmailMessage>),
        );
        await messages.transitionStatus(draft.id, ['draft'], 'sending');
        await messages.transitionStatus(draft.id, ['sending'], 'sent', { sentAt: new Date() });
        // A lost race moves nothing and records nothing.
        await messages.transitionStatus(draft.id, ['draft'], 'sending');
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['email.message.status_changed', 1],
            ['email.message.status_changed', 2],
            ['email.message.sent', 3],
        ]);
        expect(recorded[1]).toMatchObject({
            changedFields: ['status'],
            previous: { status: 'draft' },
        });
        expect(recorded[2].changedFields).toEqual(['status', 'sentAt']);
        expect(recorded[2].data).toMatchObject({ status: 'sent' });
        for (const event of recorded) expectValid(event);
    });

    it('a delivery status and a Task link record status_changed', async () => {
        const saved = await messages.save(message());
        await messages.updateDeliveryStatus(saved.id, 'bounced');
        await messages.linkTask(saved.id, randomUUID());
        await messages.linkTask(saved.id, randomUUID()); // already linked: nothing
        const recorded = (await events()).slice(1);
        expect(recorded.map((event) => event.changedFields)).toEqual([
            ['deliveryStatus'],
            ['taskId'],
        ]);
        expect(recorded[0].data).toMatchObject({ deliveryStatus: 'bounced' });
        for (const event of recorded) expectValid(event);
    });

    it('a re-save records only what the DTO shows changed, and never rolls the version back', async () => {
        const saved = await messages.save(message());
        // Bcc and metadata are not in the DTO: nothing to record.
        await messages.save({
            ...saved,
            bccAddresses: ['other@example.com'],
            metadata: { note: 'x' },
        } as EmailMessage);
        await messages.save({
            ...saved,
            deliveryStatus: 'opened',
            subject: 'Refund (2)',
        } as EmailMessage);
        // A stale copy (read at version 1) saved again must not undo the bump.
        await messages.save({
            ...saved,
            deliveryStatus: 'opened',
            subject: 'Refund (3)',
        } as EmailMessage);
        const recorded = (await events()).slice(1);
        expect(
            recorded.map((event) => [event.type, event.aggregateVersion, event.changedFields]),
        ).toEqual([
            ['email.message.status_changed', 2, ['deliveryStatus', 'subject']],
            ['email.message.status_changed', 3, ['subject']],
        ]);
        expect(recorded[0].previous).toEqual({ deliveryStatus: 'delivered' });
        expect(recorded[1].data).toMatchObject({ subject: 'Refund (3)', version: 3 });
        for (const event of recorded) expectValid(event);
    });

    it('a message outside any organization records nothing', async () => {
        await messages.save(message({ organizationId: null } as Partial<EmailMessage>));
        expect(await events()).toEqual([]);
    });

    it('an event leaves out bodies above the event limit (bodyOmitted)', async () => {
        await messages.save(message({ bodyText: 'x'.repeat(EMAIL_EVENT_BODY_MAX_BYTES + 1) }));
        const [event] = await events();
        expect(event.data).toMatchObject({ text: null, html: null, bodyOmitted: true });
        expectValid(event);
    });

    it('a listener failure never fails the write', async () => {
        const failing = new EmailMessageRepository(dataSource.getRepository(EmailMessage));
        failing.setChangeListener(async () => {
            throw new Error('outbox down');
        });
        await expect(failing.save(message())).resolves.toMatchObject({ subject: 'Refund' });
    });
});
