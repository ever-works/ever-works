import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { InboxItemRepository } from '../../database/repositories/inbox-item.repository';
import { DomainEvent } from '../../entities/domain-event.entity';
import { InboxItem } from '../../entities/inbox-item.entity';
import { Organization } from '../../entities/organization.entity';
import { InboxService } from '../../inbox/inbox.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEventFeedService } from '../domain-event-feed.service';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import { DomainEventRelayService } from '../domain-event-relay.service';
import { DomainEventRetentionService } from '../domain-event-retention.service';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Inbox recording points (EW-P3-1): the real `InboxService` + repository on
 * SQLite. Every write records after itself, in a transaction of its own
 * (best-effort, `recordAfterWrite`); each event's `data` is valid against the
 * schema its catalog row names (`resources/inbox-item.schema.json`).
 */
describe('inbox recording points', () => {
    let dataSource: DataSource;
    let inbox: InboxService;
    const expectValid = catalogDataValidator();
    const RECIPIENT = randomUUID();

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });
    const itemVersion = async (id: string) =>
        Number((await dataSource.getRepository(InboxItem).findOneByOrFail({ id })).version);
    const onlyItem = async () => {
        const rows = await dataSource.getRepository(InboxItem).find();
        expect(rows).toHaveLength(1);
        return rows[0];
    };

    function build(publisher: DomainEventPublisher | undefined): InboxService {
        // No run is ever the recipient's here: nothing is parked or resumed.
        const runs = {
            findById: async () => null,
            setAwaitingInput: async () => undefined,
        };
        return new InboxService(
            new InboxItemRepository(dataSource.getRepository(InboxItem)),
            runs as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            publisher,
        );
    }

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        inbox = build(new DomainEventPublisher(new DomainEventRecorder(), dataSource));
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of ['inbox_items', 'organizations']) {
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

    const fileNotice = () =>
        inbox.notice(RECIPIENT, {
            title: 'Deploy finished',
            body: 'Your site is live.',
            organizationId: ORG_A,
            notify: false,
        });

    it('a filed item records inbox.item.created at version 1 with a valid DTO (tenant from its organization)', async () => {
        await fileNotice();
        const item = await onlyItem();
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'inbox.item.created',
            aggregateType: 'inbox_item',
            aggregateId: item.id,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
        });
        expect(event.data).toMatchObject({
            id: item.id,
            recipientUserId: RECIPIENT,
            kind: 'notice',
            status: 'open',
            unread: true,
            version: 1,
        });
        expect(event.data).not.toHaveProperty('sourceMeta');
        expectValid(event);
    });

    it('records inbox events recipient-scoped: the feed serves them only with inbox:read', async () => {
        await fileNotice();
        const item = await onlyItem();
        await inbox.setUnread(item.id, RECIPIENT, false);
        const recorded = await events();
        expect(recorded.length).toBeGreaterThan(0);
        expect(recorded.map((event) => event.visibility)).toEqual(recorded.map(() => 'recipient'));

        const relay = new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
            new EventEmitter2(),
        );
        await relay.tick();
        await relay.stop();
        const feed = new DomainEventFeedService(dataSource);
        const read = (grantedScopes?: string[]) =>
            feed.readPage({ organizationIds: [ORG_A], after: '0', grantedScopes });
        // `events:read` alone (or no scopes at all): one person's messages stay out.
        expect((await read()).events).toEqual([]);
        expect((await read(['events:read', 'tasks:read'])).events).toEqual([]);
        // With `inbox:read` the integration reads every recipient's messages.
        expect((await read(['events:read', 'inbox:read'])).events.map((e) => e.type)).toEqual([
            'inbox.item.created',
            'inbox.item.state_changed',
        ]);
    });

    it('every producer records created: escalation and approval mirrors too', async () => {
        await inbox.escalationRaised({
            userId: RECIPIENT,
            escalationId: randomUUID(),
            summary: 'Budget exceeded',
            decisionNeeded: 'Raise the cap or stop the run?',
            organizationId: ORG_A,
        } as never);
        await inbox.proposalPending({
            userId: RECIPIENT,
            proposalId: randomUUID(),
            title: 'Send the newsletter',
            actionType: 'email.send',
            organizationId: ORG_A,
        } as never);
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.data.kind])).toEqual([
            ['inbox.item.created', 'escalation'],
            ['inbox.item.created', 'approval'],
        ]);
        expect(recorded[1].data.options).toEqual([
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
        ]);
        for (const event of recorded) expectValid(event);
    });

    it('read / unread and archive / restore record inbox.item.state_changed — only for a real flip', async () => {
        await fileNotice();
        const { id } = await onlyItem();
        await inbox.setUnread(id, RECIPIENT, false);
        await inbox.setUnread(id, RECIPIENT, false); // already read: nothing recorded
        await inbox.setArchived(id, RECIPIENT, true);
        await inbox.setArchived(id, RECIPIENT, false);
        const recorded = (await events()).slice(1);
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['inbox.item.state_changed', 2],
            ['inbox.item.state_changed', 3],
            ['inbox.item.state_changed', 4],
        ]);
        expect(recorded[0]).toMatchObject({
            changedFields: ['unread'],
            previous: { unread: true },
        });
        expect(recorded[0].data).toMatchObject({ unread: false });
        expect(recorded[1]).toMatchObject({
            changedFields: ['status'],
            previous: { status: 'open' },
        });
        expect(recorded[1].data).toMatchObject({ status: 'archived' });
        expect(recorded[2]).toMatchObject({ previous: { status: 'archived' } });
        expect(recorded[2].data).toMatchObject({ status: 'open' });
        for (const event of recorded) expectValid(event);
        expect(await itemVersion(id)).toBe(4);
    });

    it('a reply records inbox.item.answered once; a second reply is refused and records nothing', async () => {
        await fileNotice();
        const { id } = await onlyItem();
        await inbox.reply(RECIPIENT, id, { text: 'Thanks' });
        await expect(inbox.reply(RECIPIENT, id, { text: 'Again' })).rejects.toThrow(
            /already answered/,
        );
        const recorded = (await events()).slice(1);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            type: 'inbox.item.answered',
            aggregateVersion: 2,
            previous: { status: 'open', unread: true },
        });
        expect(recorded[0].data).toMatchObject({
            status: 'answered',
            unread: false,
            answerText: 'Thanks',
        });
        expectValid(recorded[0]);
    });

    it('a reply whose routing fails records no answer, but the read flip the claim made (state_changed)', async () => {
        const failingApprovals = {
            decide: async () => {
                throw new Error('approvals down');
            },
        };
        const withFailingRouting = new InboxService(
            new InboxItemRepository(dataSource.getRepository(InboxItem)),
            { findById: async () => null, setAwaitingInput: async () => undefined } as never,
            undefined,
            failingApprovals as never,
            undefined,
            undefined,
            undefined,
            new DomainEventPublisher(new DomainEventRecorder(), dataSource),
        );
        await withFailingRouting.proposalPending({
            userId: RECIPIENT,
            proposalId: randomUUID(),
            title: 'Send the newsletter',
            actionType: 'email.send',
            organizationId: ORG_A,
        } as never);
        const { id } = await onlyItem();
        await expect(
            withFailingRouting.reply(RECIPIENT, id, { optionId: 'approve' }),
        ).rejects.toThrow(/approvals down/);
        const recorded = (await events()).slice(1);
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['inbox.item.state_changed', 2],
        ]);
        expect(recorded[0]).toMatchObject({
            changedFields: ['unread'],
            previous: { unread: true },
        });
        expect(recorded[0].data).toMatchObject({
            status: 'open',
            unread: false,
            answerOptionId: null,
        });
        expectValid(recorded[0]);
    });

    it('an escalation resolved elsewhere and a proposal decided elsewhere record inbox.item.answered', async () => {
        const escalationId = randomUUID();
        const proposalId = randomUUID();
        await inbox.escalationRaised({
            userId: RECIPIENT,
            escalationId,
            summary: 'Budget exceeded',
            decisionNeeded: 'Raise the cap?',
            organizationId: ORG_A,
        } as never);
        await inbox.proposalPending({
            userId: RECIPIENT,
            proposalId,
            title: 'Send the newsletter',
            actionType: 'email.send',
            organizationId: ORG_A,
        } as never);
        await inbox.escalationResolved({
            escalationId,
            note: 'Raised to $50',
            resolvedByUserId: RECIPIENT,
        } as never);
        await inbox.proposalDecided({
            proposalId,
            decision: 'approved',
            decidedByUserId: RECIPIENT,
        } as never);
        // A second resolve of the same escalation is a no-op (the CAS lost).
        await inbox.escalationResolved({ escalationId, note: 'again' } as never);
        const answered = (await events()).filter((event) => event.type === 'inbox.item.answered');
        expect(answered.map((event) => [event.data.kind, event.data.answerOptionId])).toEqual([
            ['escalation', null],
            ['approval', 'approve'],
        ]);
        expect(answered[0].data).toMatchObject({ answerText: 'Raised to $50' });
        for (const event of answered) expectValid(event);
    });

    it('a delete records inbox.item.deleted with the last snapshot, its own version and deleted: true', async () => {
        await fileNotice();
        const { id } = await onlyItem();
        await inbox.delete(id, RECIPIENT);
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['inbox.item.created', 1],
            ['inbox.item.deleted', 2],
        ]);
        expect(recorded[1].data).toMatchObject({ id, title: 'Deploy finished', deleted: true });
        expectValid(recorded[1]);
        expect(await dataSource.getRepository(InboxItem).count()).toBe(0);
    });

    it("a foreign user's state change / delete is refused and records nothing", async () => {
        await fileNotice();
        const { id } = await onlyItem();
        const stranger = randomUUID();
        await expect(inbox.setUnread(id, stranger, false)).rejects.toThrow(/not found/);
        await expect(inbox.delete(id, stranger)).rejects.toThrow(/not found/);
        expect((await events()).map((event) => event.type)).toEqual(['inbox.item.created']);
        expect(await itemVersion(id)).toBe(1);
    });

    it('a recording failure never fails the write it describes', async () => {
        const failing = build({
            transaction: async () => {
                throw new Error('outbox down');
            },
        } as unknown as DomainEventPublisher);
        await expect(
            failing.notice(RECIPIENT, { title: 'Hi', body: 'There', notify: false }),
        ).resolves.toBeUndefined();
        const { id } = await onlyItem();
        await expect(failing.setUnread(id, RECIPIENT, false)).resolves.toMatchObject({
            unread: false,
        });
        await expect(failing.delete(id, RECIPIENT)).resolves.toBeUndefined();
        expect(await events()).toEqual([]);
    });
});
