import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import {
    DomainEventCursorExpiredError,
    DomainEventFeedService,
} from '../domain-event-feed.service';
import type { RecordDomainEventInput } from '../domain-event-recorder.service';
import { DomainEventRelayService } from '../domain-event-relay.service';
import { DomainEventRetentionService } from '../domain-event-retention.service';
import { DomainEventRelayState } from '../../entities/domain-event-relay-state.entity';
import {
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    recordMany,
    resetDomainEventsTables,
} from './domain-events.test-helpers';

describe('DomainEventFeedService', () => {
    let dataSource: DataSource;
    let feed: DomainEventFeedService;

    const dispatch = async () => {
        const relay = new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
            new EventEmitter2(),
        );
        await relay.tick();
        await relay.stop();
    };

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        feed = new DomainEventFeedService(dataSource);
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('serves only dispatched events of the asked organizations, in seq order, with the head', async () => {
        await recordMany(dataSource, 4, (index) => ({
            organizationId: index % 2 === 0 ? ORG_A : ORG_B,
        }));
        // Undispatched rows are invisible.
        expect((await feed.readPage({ organizationIds: [ORG_A], after: '0' })).events).toEqual([]);
        await dispatch();
        const page = await feed.readPage({ organizationIds: [ORG_A], after: '0' });
        expect(page.events.map((event) => event.seq)).toEqual(['1', '3']);
        expect(page.events.every((event) => event.organizationId === ORG_A)).toBe(true);
        // Nothing after 3 is ORG_A's, so the cursor moves straight to the head.
        expect(page).toMatchObject({ head: '4', hasMore: false, nextCursor: '4' });
    });

    it('moves a quiet organization’s cursor to the head, so it never falls below the retention floor', async () => {
        await recordMany(dataSource, 3, () => ({ organizationId: ORG_B }));
        await dispatch();
        const page = await feed.readPage({ organizationIds: [ORG_A], after: '0' });
        expect(page).toEqual({ events: [], nextCursor: '3', hasMore: false, head: '3' });
    });

    it('never returns a position past the head it reports', async () => {
        await recordMany(dataSource, 3);
        await dispatch();
        // A batch the relay commits between this page's head read and its scan:
        // a dispatched row above the recorded head.
        await dataSource.query(
            `UPDATE "domain_events" SET "seq" = 4 WHERE "outboxSeq" = (SELECT MAX("outboxSeq") FROM "domain_events")`,
        );
        await dataSource
            .getRepository(DomainEventRelayState)
            .update({ id: 'relay' }, { lastSeq: 2 });
        const page = await feed.readPage({ organizationIds: [ORG_A], after: '0' });
        expect(page.head).toBe('2');
        expect(page.events.map((event) => event.seq)).toEqual(['1', '2']);
        expect(page.nextCursor).toBe('2');
    });

    it('answers cursor_expired when retention passes the cursor while the page is being scanned', async () => {
        await recordMany(dataSource, 3);
        await dispatch();
        const scan = (
            feed as unknown as { scan: (...args: unknown[]) => Promise<unknown> }
        ).scan.bind(feed);
        const spy = jest
            .spyOn(feed as unknown as { scan: (...args: unknown[]) => Promise<unknown> }, 'scan')
            .mockImplementationOnce(async (...args: unknown[]) => {
                const rows = await scan(...args);
                await dataSource
                    .getRepository(DomainEventRelayState)
                    .update({ id: 'relay' }, { retentionFloorSeq: 2 });
                return rows;
            });
        try {
            await expect(
                feed.readPage({ organizationIds: [ORG_A], after: '1' }),
            ).rejects.toBeInstanceOf(DomainEventCursorExpiredError);
        } finally {
            spy.mockRestore();
        }
    });

    it('treats a non-finite limit as the default instead of looping on an empty page', async () => {
        await recordMany(dataSource, 3);
        await dispatch();
        for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
            const page = await feed.readPage({ organizationIds: [ORG_A], after: '0', limit });
            expect(page.events.map((event) => event.seq)).toEqual(['1', '2', '3']);
            expect(page.hasMore).toBe(false);
        }
    });

    it('never serves personal-scope events', async () => {
        await recordMany(dataSource, 1, () => ({ organizationId: null }));
        await dispatch();
        expect((await feed.readPage({ organizationIds: [ORG_A], after: '0' })).events).toEqual([]);
    });

    it('pages with limit and nextCursor without losing or repeating an event', async () => {
        await recordMany(dataSource, 5);
        await dispatch();
        const first = await feed.readPage({ organizationIds: [ORG_A], after: '0', limit: 2 });
        expect(first.events.map((event) => event.seq)).toEqual(['1', '2']);
        expect(first).toMatchObject({ nextCursor: '2', hasMore: true });
        const second = await feed.readPage({
            organizationIds: [ORG_A],
            after: first.nextCursor as string,
            limit: 2,
        });
        expect(second.events.map((event) => event.seq)).toEqual(['3', '4']);
        const third = await feed.readPage({
            organizationIds: [ORG_A],
            after: second.nextCursor as string,
            limit: 2,
        });
        expect(third.events.map((event) => event.seq)).toEqual(['5']);
        expect(third.hasMore).toBe(false);
    });

    it('hides private aggregates but always serves the id-only private notice', async () => {
        const id = randomUUID();
        await recordMany(
            dataSource,
            3,
            (index) =>
                (
                    [
                        { data: { id, visibility: 'private', title: 'secret' } },
                        {
                            type: 'task.visibility_changed',
                            aggregate: { type: 'task', id, version: 3 },
                            data: { id, visibility: 'private' },
                        },
                        { data: { id: randomUUID(), visibility: 'team' } },
                    ] as Partial<RecordDomainEventInput>[]
                )[index],
        );
        await dispatch();
        const page = await feed.readPage({ organizationIds: [ORG_A], after: '0' });
        expect(page.events.map((event) => event.type)).toEqual([
            'task.visibility_changed',
            'task.updated',
        ]);
        expect(page.events[0].data).toEqual({ id, visibility: 'private' });
        expect(JSON.stringify(page.events)).not.toContain('secret');
    });

    it('drops the caller’s own writes with excludeOrigins (loop guard)', async () => {
        await recordMany(dataSource, 2, (index) => ({
            originTag: index === 0 ? 'gauzy:conn-1' : null,
        }));
        await dispatch();
        const page = await feed.readPage({
            organizationIds: [ORG_A],
            after: '0',
            excludeOrigins: ['gauzy:conn-1'],
        });
        expect(page.events.map((event) => event.seq)).toEqual(['2']);
        // The cursor still moves past the filtered row.
        expect(page.nextCursor).toBe('2');
    });

    it('filters by types and serves opt-in types only when named exactly', async () => {
        await recordMany(dataSource, 3, (index) => ({
            type: ['task.updated', 'task.runtime_updated', 'team.created'][index],
            aggregate: { type: index === 2 ? 'team' : 'task', id: randomUUID(), version: 1 },
        }));
        await dispatch();
        const all = await feed.readPage({ organizationIds: [ORG_A], after: '0' });
        expect(all.events.map((event) => event.type)).toEqual(['task.updated', 'team.created']);
        const tasks = await feed.readPage({
            organizationIds: [ORG_A],
            after: '0',
            types: ['task.*'],
        });
        expect(tasks.events.map((event) => event.type)).toEqual(['task.updated']);
        const runtime = await feed.readPage({
            organizationIds: [ORG_A],
            after: '0',
            types: ['task.*', 'task.runtime_updated'],
        });
        expect(runtime.events.map((event) => event.type)).toEqual([
            'task.updated',
            'task.runtime_updated',
        ]);
    });

    it('answers cursor_expired for a cursor below the retention floor', async () => {
        await dataSource
            .getRepository(DomainEventRelayState)
            .update({ id: 'relay' }, { retentionFloorSeq: 10 });
        await expect(
            feed.readPage({ organizationIds: [ORG_A], after: '9' }),
        ).rejects.toBeInstanceOf(DomainEventCursorExpiredError);
        await expect(
            feed.readPage({ organizationIds: [ORG_A], after: '10' }),
        ).resolves.toMatchObject({
            events: [],
        });
    });

    it('answers an empty page for no organizations', async () => {
        await recordMany(dataSource, 1);
        await dispatch();
        expect(await feed.readPage({ organizationIds: [], after: '0' })).toEqual({
            events: [],
            nextCursor: null,
            hasMore: false,
            head: '1',
        });
    });
});
