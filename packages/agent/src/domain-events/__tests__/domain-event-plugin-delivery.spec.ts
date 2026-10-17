import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEventEnvelope } from '@ever-works/contracts';
import type { IDomainEventSubscriberPlugin, PluginEventContext } from '@ever-works/plugin';
import type { DataSource } from 'typeorm';
import { PluginEventCursor } from '../../entities/plugin-event-cursor.entity';
import { Tenant } from '../../entities/tenant.entity';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { DOMAIN_EVENT_PLUGIN_MAX_FAILURES } from '../domain-events.config';
import {
    DomainEventPluginDeliveryService,
    PLUGIN_EVENT_ANCHOR_TENANT_ID,
    type ResolvedDomainEventSubscriber,
} from '../domain-event-plugin-delivery.service';
import { DomainEventRelayService } from '../domain-event-relay.service';
import { DomainEventRetentionService } from '../domain-event-retention.service';
import {
    createDomainEventsDataSource,
    recordMany,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

const OTHER_TENANT = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

describe('DomainEventPluginDeliveryService', () => {
    let dataSource: DataSource;
    let enabledOwners: Set<string>;
    let delivery: DomainEventPluginDeliveryService;
    const ownerOf: Record<string, string> = {};

    /** A registry stub: only `isPluginEnabledForScope` is used by deliverFor. */
    const registry = {
        getByCapability: () => [],
        isPluginEnabledForScope: async (_pluginId: string, _workId?: string, userId?: string) =>
            !!userId && enabledOwners.has(userId),
    } as unknown as PluginRegistryService;

    function subscriber(
        subscribes: readonly string[],
        handler: (event: DomainEventEnvelope, ctx: PluginEventContext) => Promise<void>,
    ): ResolvedDomainEventSubscriber {
        const plugin = {
            id: 'test-subscriber',
            name: 'Test subscriber',
            version: '1.0.0',
            capabilities: ['domain-event-subscriber'],
            subscribes,
            onDomainEvent: handler,
        } as unknown as IDomainEventSubscriberPlugin;
        return { pluginId: 'test-subscriber', plugin };
    }

    async function dispatch(): Promise<void> {
        const relay = new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
            new EventEmitter2(),
        );
        await relay.tick();
        await relay.stop();
    }

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        delivery = new DomainEventPluginDeliveryService(dataSource, registry);
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        enabledOwners = new Set();
        for (const tenantId of [TENANT, OTHER_TENANT]) {
            ownerOf[tenantId] = randomUUID();
            await dataSource.getRepository(Tenant).insert({
                id: tenantId,
                ownerUserId: ownerOf[tenantId],
                slug: `t-${tenantId.slice(0, 8)}`,
                displayName: 'Tenant',
            });
        }
        enabledOwners.add(ownerOf[TENANT]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('anchors a newly seen plugin at the current head: it receives new events, not history', async () => {
        const seen: string[] = [];
        const sub = subscriber(['*'], async (event) => {
            seen.push(event.seq);
        });
        await recordMany(dataSource, 2);
        await dispatch();
        await delivery.deliverFor(sub); // first sight: anchor at head 2
        expect(seen).toEqual([]);
        const anchor = await dataSource.getRepository(PluginEventCursor).findOneByOrFail({
            pluginId: 'test-subscriber',
            tenantId: PLUGIN_EVENT_ANCHOR_TENANT_ID,
        });
        expect(String(anchor.lastSeq)).toBe('2');

        await recordMany(dataSource, 2);
        await dispatch();
        await delivery.deliverFor(sub);
        expect(seen).toEqual(['3', '4']);
    });

    it('delivers in seq order, only matching patterns, only to enabled tenants, and moves cursors', async () => {
        const sub = subscriber(['task.updated'], async (event) => {
            seen.push(`${event.seq}:${event.tenantId === TENANT ? 'A' : 'B'}`);
        });
        const seen: string[] = [];
        await delivery.deliverFor(sub); // anchor at 0
        await recordMany(dataSource, 4, (index) => ({
            tenantId: index === 2 ? OTHER_TENANT : TENANT,
            type: index === 1 ? 'task.created' : 'task.updated',
        }));
        await dispatch();
        await delivery.deliverFor(sub);
        // seq 2 is task.created (not subscribed), seq 3 belongs to a tenant without the plugin.
        expect(seen).toEqual(['1:A', '4:A']);
        const cursors = await dataSource
            .getRepository(PluginEventCursor)
            .find({ where: { pluginId: 'test-subscriber' } });
        const byTenant = Object.fromEntries(
            cursors.map((cursor) => [cursor.tenantId, String(cursor.lastSeq)]),
        );
        expect(byTenant[TENANT]).toBe('4');
        // The other tenant (plugin not enabled) has nothing pending up to 4: it moves to 4.
        expect(byTenant[OTHER_TENANT]).toBe('4');
    });

    it('retries a failed event on the next pass and holds back that tenant’s later events', async () => {
        let failNext = true;
        const seen: string[] = [];
        const sub = subscriber(['*'], async (event, ctx) => {
            if (failNext && event.seq === '1') {
                failNext = false;
                throw new Error('downstream 503');
            }
            seen.push(`${event.seq}@${ctx.attempt}`);
        });
        await delivery.deliverFor(sub);
        await recordMany(dataSource, 2);
        await dispatch();

        await delivery.deliverFor(sub);
        expect(seen).toEqual([]); // 1 failed, 2 waits behind it
        const cursor = await dataSource
            .getRepository(PluginEventCursor)
            .findOneByOrFail({ pluginId: 'test-subscriber', tenantId: TENANT });
        expect(cursor).toMatchObject({ consecutiveFailures: 1, lastError: 'downstream 503' });

        await delivery.deliverFor(sub);
        expect(seen).toEqual(['1@2', '2@1']);
    });

    it(`dead-letters an event after ${DOMAIN_EVENT_PLUGIN_MAX_FAILURES} consecutive failures and moves on`, async () => {
        const seen: string[] = [];
        const sub = subscriber(['*'], async (event) => {
            if (event.seq === '1') throw new Error('always broken');
            seen.push(event.seq);
        });
        await delivery.deliverFor(sub);
        await recordMany(dataSource, 2);
        await dispatch();
        for (let pass = 0; pass < DOMAIN_EVENT_PLUGIN_MAX_FAILURES; pass++) {
            await delivery.deliverFor(sub);
        }
        const cursor = await dataSource
            .getRepository(PluginEventCursor)
            .findOneByOrFail({ pluginId: 'test-subscriber', tenantId: TENANT });
        expect(cursor.deadLetterCount).toBe(1);
        expect(cursor.lastDeadLetterEventId).toMatch(/^evt_/);
        await delivery.deliverFor(sub);
        expect(seen).toEqual(['2']);
    });

    it('does not let a quiet tenant pin the scan: a busy tenant gets past one batch', async () => {
        const seen: string[] = [];
        const sub = subscriber(['*'], async (event) => {
            if (event.tenantId === TENANT) seen.push(event.seq);
        });
        enabledOwners.add(ownerOf[OTHER_TENANT]);
        await delivery.deliverFor(sub); // anchor at 0
        // One event of a tenant that then goes quiet, then 250 of a busy tenant.
        await recordMany(dataSource, 1, () => ({ tenantId: OTHER_TENANT }));
        await recordMany(dataSource, 250);
        await dispatch();
        await dispatch(); // the relay gives 200 positions per tick
        for (let pass = 0; pass < 3; pass++) await delivery.deliverFor(sub);
        expect(seen).toHaveLength(250);
        expect(seen[seen.length - 1]).toBe('251');
    });

    it('stops before calling the plugin once the relay lease is lost, keeping progress so far', async () => {
        const seen: string[] = [];
        const sub = subscriber(['*'], async (event) => {
            seen.push(event.seq);
        });
        await delivery.deliverFor(sub);
        await recordMany(dataSource, 3);
        await dispatch();
        let calls = 0;
        await delivery.deliverFor(sub, { keepLease: async () => ++calls <= 1 });
        expect(seen).toEqual(['1']);
        const cursor = await dataSource
            .getRepository(PluginEventCursor)
            .findOneByOrFail({ pluginId: 'test-subscriber', tenantId: TENANT });
        expect(String(cursor.lastSeq)).toBe('1');
    });

    it('never overwrites progress another replica made meanwhile (compare-and-set cursors)', async () => {
        const sub = subscriber(['*'], async (event) => {
            if (event.seq === '2') {
                // Another replica advances this tenant's cursor while we deliver.
                await dataSource
                    .getRepository(PluginEventCursor)
                    .update({ pluginId: 'test-subscriber', tenantId: TENANT }, { lastSeq: 9 });
            }
        });
        await delivery.deliverFor(sub);
        await recordMany(dataSource, 1);
        await dispatch();
        await delivery.deliverFor(sub); // creates the tenant cursor at 1
        await recordMany(dataSource, 2);
        await dispatch();
        await delivery.deliverFor(sub);
        const cursor = await dataSource
            .getRepository(PluginEventCursor)
            .findOneByOrFail({ pluginId: 'test-subscriber', tenantId: TENANT });
        expect(String(cursor.lastSeq)).toBe('9');
    });

    it('times out a hanging plugin and aborts its signal', async () => {
        const previous = process.env.DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS;
        process.env.DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS = '100';
        let aborted = false;
        try {
            const sub = subscriber(['*'], (_event, ctx) => {
                ctx.signal.addEventListener('abort', () => {
                    aborted = true;
                });
                return new Promise(() => undefined);
            });
            await delivery.deliverFor(sub);
            await recordMany(dataSource, 1);
            await dispatch();
            await delivery.deliverFor(sub);
            const cursor = await dataSource
                .getRepository(PluginEventCursor)
                .findOneByOrFail({ pluginId: 'test-subscriber', tenantId: TENANT });
            expect(cursor.lastError).toMatch(/timed out/);
            expect(aborted).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS;
            else process.env.DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS = previous;
        }
    });
});
