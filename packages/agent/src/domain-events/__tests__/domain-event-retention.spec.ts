import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import { DomainEvent } from '../../entities/domain-event.entity';
import { DomainEventRelayState } from '../../entities/domain-event-relay-state.entity';
import {
    DomainEventCursorExpiredError,
    DomainEventFeedService,
} from '../domain-event-feed.service';
import { DomainEventRelayService } from '../domain-event-relay.service';
import { DomainEventRetentionService } from '../domain-event-retention.service';
import {
    createDomainEventsDataSource,
    ORG_A,
    recordMany,
    resetDomainEventsTables,
} from './domain-events.test-helpers';

describe('DomainEventRetentionService', () => {
    let dataSource: DataSource;
    let retention: DomainEventRetentionService;
    const NOW = new Date('2026-10-15T18:00:00Z');
    const DAY = 24 * 60 * 60 * 1000;

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        retention = new DomainEventRetentionService(dataSource);
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function dispatchAt(when: Date): Promise<void> {
        // A relay whose own hourly retention is a no-op, so only the explicit purge below deletes.
        const idle = {
            purge: async () => ({ deleted: 0, floor: '0' }),
        } as unknown as DomainEventRetentionService;
        const relay = new DomainEventRelayService(dataSource, idle, new EventEmitter2());
        await relay.tick(when);
        await relay.stop();
    }

    it('deletes dispatched rows older than the window, keeps newer ones and records the floor', async () => {
        await recordMany(dataSource, 2);
        await dispatchAt(new Date(NOW.getTime() - 40 * DAY));
        await recordMany(dataSource, 1);
        await dispatchAt(new Date(NOW.getTime() - 1 * DAY));

        const result = await retention.purge(NOW, 30);
        expect(result).toEqual({ deleted: 2, floor: '2' });
        const left = await dataSource.getRepository(DomainEvent).find();
        expect(left.map((row) => String(row.seq))).toEqual(['3']);
    });

    it('never deletes an undispatched row, whatever its age', async () => {
        await recordMany(dataSource, 1, () => ({
            occurredAt: new Date(NOW.getTime() - 400 * DAY),
        }));
        expect(await retention.purge(NOW, 30)).toEqual({ deleted: 0, floor: '0' });
        expect(await dataSource.getRepository(DomainEvent).count()).toBe(1);
    });

    it('makes the feed answer cursor_expired below the floor', async () => {
        await recordMany(dataSource, 2);
        await dispatchAt(new Date(NOW.getTime() - 40 * DAY));
        await retention.purge(NOW, 30);
        const feed = new DomainEventFeedService(dataSource);
        await expect(
            feed.readPage({ organizationIds: [ORG_A], after: '1' }),
        ).rejects.toBeInstanceOf(DomainEventCursorExpiredError);
        await expect(
            feed.readPage({ organizationIds: [ORG_A], after: '2' }),
        ).resolves.toMatchObject({
            events: [],
        });
    });

    it('never lowers the floor', async () => {
        await dataSource
            .getRepository(DomainEventRelayState)
            .update({ id: 'relay' }, { retentionFloorSeq: 50 });
        await recordMany(dataSource, 1);
        await dispatchAt(new Date(NOW.getTime() - 40 * DAY));
        expect(await retention.purge(NOW, 30)).toEqual({ deleted: 1, floor: '50' });
    });
});
