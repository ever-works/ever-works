import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Team } from '../../entities/team.entity';
import { runWithDomainEventContext, normalizeSyncOrigin } from '../domain-event-context';
import { DOMAIN_EVENT_ID_PATTERN, newDomainEventId } from '../domain-event-id';
import {
    DomainEventRecorder,
    SYSTEM_ACTOR,
    UnknownDomainEventTypeError,
} from '../domain-event-recorder.service';
import {
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    taskEventInput,
    TENANT,
} from './domain-events.test-helpers';

describe('newDomainEventId', () => {
    it('is evt_ + a 26-character Crockford ULID, unique per call', () => {
        const ids = new Set(Array.from({ length: 500 }, () => newDomainEventId()));
        expect(ids.size).toBe(500);
        for (const id of ids) expect(id).toMatch(DOMAIN_EVENT_ID_PATTERN);
    });

    it('sorts by its millisecond timestamp', () => {
        expect(newDomainEventId(1_000).slice(0, 14) < newDomainEventId(2_000).slice(0, 14)).toBe(
            true,
        );
    });
});

describe('normalizeSyncOrigin', () => {
    it('keeps a printable tag of at most 100 characters', () => {
        expect(normalizeSyncOrigin(' gauzy:8f3c ')).toBe('gauzy:8f3c');
        expect(normalizeSyncOrigin(['gauzy:a', 'gauzy:b'])).toBe('gauzy:a');
    });

    it('drops anything else instead of failing the write', () => {
        expect(normalizeSyncOrigin('x'.repeat(101))).toBeNull();
        expect(normalizeSyncOrigin('gauzy: spaced')).toBeNull();
        expect(normalizeSyncOrigin('')).toBeNull();
        expect(normalizeSyncOrigin(undefined)).toBeNull();
        expect(normalizeSyncOrigin(42)).toBeNull();
    });
});

describe('DomainEventRecorder', () => {
    let dataSource: DataSource;
    const recorder = new DomainEventRecorder();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('writes an undispatched outbox row with every envelope field', async () => {
        const input = taskEventInput({ originTag: 'gauzy:conn-1', correlationId: 'req-1' });
        const row = await dataSource.transaction((manager) => recorder.record(manager, input));

        const stored = await dataSource.getRepository(DomainEvent).findOneByOrFail({ id: row.id });
        expect(stored.id).toMatch(DOMAIN_EVENT_ID_PATTERN);
        expect(stored).toMatchObject({
            type: 'task.updated',
            version: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
            aggregateType: 'task',
            aggregateId: input.aggregate.id,
            aggregateVersion: 2,
            visibility: 'organization',
            actorType: 'user',
            actorId: input.actor?.id,
            actorLabel: 'ruslan',
            originTag: 'gauzy:conn-1',
            changedFields: ['title'],
            previous: { title: 'Ship' },
            correlationId: 'req-1',
            seq: null,
            dispatchedAt: null,
        });
        expect(stored.data).toEqual(input.data);
    });

    it('commits and rolls back WITH the state change', async () => {
        await expect(
            dataSource.transaction(async (manager) => {
                await recorder.record(manager, taskEventInput());
                throw new Error('the mutation failed');
            }),
        ).rejects.toThrow('the mutation failed');
        expect(await dataSource.getRepository(DomainEvent).count()).toBe(0);

        await dataSource.transaction((manager) => recorder.record(manager, taskEventInput()));
        expect(await dataSource.getRepository(DomainEvent).count()).toBe(1);
    });

    it('refuses a type outside the catalog', async () => {
        await expect(
            dataSource.transaction((manager) =>
                recorder.record(manager, taskEventInput({ type: 'task.renamed' })),
            ),
        ).rejects.toBeInstanceOf(UnknownDomainEventTypeError);
        expect(await dataSource.getRepository(DomainEvent).count()).toBe(0);
    });

    it('takes actor, origin, key and correlation from the active context when the caller passes none', async () => {
        const keyId = randomUUID();
        const row = await runWithDomainEventContext(
            {
                actor: { type: 'integration', id: keyId, label: 'Ever Gauzy (Acme)' },
                originTag: 'gauzy:conn-2',
                integrationKeyId: keyId,
                correlationId: 'req-2',
            },
            () =>
                dataSource.transaction((manager) =>
                    recorder.record(manager, taskEventInput({ actor: undefined })),
                ),
        );
        expect(row).toMatchObject({
            actorType: 'integration',
            actorId: keyId,
            actorLabel: 'Ever Gauzy (Acme)',
            originTag: 'gauzy:conn-2',
            integrationKeyId: keyId,
            correlationId: 'req-2',
        });
    });

    it('falls back to the system actor outside any context', async () => {
        const row = await dataSource.transaction((manager) =>
            recorder.record(manager, taskEventInput({ actor: undefined })),
        );
        expect(row.actorType).toBe(SYSTEM_ACTOR.type);
        expect(row.actorId).toBe('system');
    });

    it('records the private notice with its visibility so the feed can tell it apart', async () => {
        const id = randomUUID();
        const row = await dataSource.transaction((manager) =>
            recorder.record(
                manager,
                taskEventInput({
                    type: 'task.visibility_changed',
                    aggregate: { type: 'task', id, version: 5 },
                    data: { id, visibility: 'private' },
                }),
            ),
        );
        expect(row.visibility).toBe('private');
    });

    describe('aggregate versions', () => {
        async function seedTeam(): Promise<string> {
            const id = randomUUID();
            await dataSource.getRepository(Team).insert({
                id,
                userId: randomUUID(),
                name: 'Platform',
                slug: `platform-${id.slice(0, 6)}`,
                organizationId: ORG_A,
                tenantId: TENANT,
            });
            return id;
        }

        it('starts at 1 and increments by one per bump, also moving updatedAt', async () => {
            const id = await seedTeam();
            const before = await dataSource.getRepository(Team).findOneByOrFail({ id });
            expect(before.version).toBe(1);

            await new Promise((resolve) => setTimeout(resolve, 1100));
            const first = await dataSource.transaction((manager) =>
                recorder.bumpAggregateVersion(manager, 'team', id),
            );
            const second = await dataSource.transaction((manager) =>
                recorder.bumpAggregateVersion(manager, 'team', id),
            );
            expect([first, second]).toEqual([2, 3]);
            const after = await dataSource.getRepository(Team).findOneByOrFail({ id });
            expect(after.version).toBe(3);
            expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
                new Date(before.updatedAt).getTime(),
            );
        });

        it('rolls the bump back with the transaction', async () => {
            const id = await seedTeam();
            await expect(
                dataSource.transaction(async (manager) => {
                    await recorder.bumpAggregateVersion(manager, 'team', id);
                    throw new Error('rollback');
                }),
            ).rejects.toThrow('rollback');
            expect(await recorder.readAggregateVersion(dataSource.manager, 'team', id)).toBe(1);
        });

        it('reads the current version without changing it, and 1 for a missing row', async () => {
            const id = await seedTeam();
            expect(await recorder.readAggregateVersion(dataSource.manager, 'team', id)).toBe(1);
            expect(
                await recorder.readAggregateVersion(dataSource.manager, 'team', randomUUID()),
            ).toBe(1);
        });

        it('refuses an aggregate type that has no version column', async () => {
            // Every catalog type is versioned since P2-P4 (goal, mission, kb_*,
            // email_message); the guard still stands for a type outside the map.
            await expect(
                recorder.bumpAggregateVersion(
                    dataSource.manager,
                    'not_an_aggregate' as never,
                    randomUUID(),
                ),
            ).rejects.toThrow(/no version column/);
        });
    });
});
