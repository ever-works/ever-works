import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { ExternalRecordLink } from '../../entities/external-record-link.entity';
import { IntegrationIdempotencyKey } from '../../entities/integration-idempotency-key.entity';
import { Team } from '../../entities/team.entity';
import {
    ExternalRecordLinksService,
    installationFromOrigin,
    toExternalRecordLinkDto,
} from '../external-record-links.service';
import { assertIfMatch, etagFor, parseIfMatch } from '../if-match';
import {
    DuplicateExternalRefError,
    IdempotencyConflictError,
    InvalidCursorError,
    VersionMismatchError,
} from '../integration-api.errors';
import {
    IDEMPOTENCY_TTL_MS,
    idempotencyRequestHash,
    IntegrationIdempotencyService,
} from '../integration-idempotency.service';
import {
    decodeKeysetCursor,
    encodeKeysetCursor,
    keysetLimit,
    readKeysetPage,
} from '../keyset-cursor';

/**
 * Integration API v1 building blocks (EW-P1-4) on SQLite: external record
 * links, the Idempotency-Key store, keyset paging and If-Match.
 */
describe('integration API v1 foundation', () => {
    let dataSource: DataSource;
    let links: ExternalRecordLinksService;
    let idempotency: IntegrationIdempotencyService;
    const KEY = randomUUID();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        links = new ExternalRecordLinksService(dataSource);
        idempotency = new IntegrationIdempotencyService(dataSource);
    });

    beforeEach(async () => {
        for (const table of ['external_record_links', 'integration_idempotency_keys', 'teams']) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    describe('external record links', () => {
        const scope = {
            organizationId: ORG_A,
            tenantId: TENANT,
            source: 'gauzy',
            installationId: 'conn-1',
        };

        it('links a record and finds it back from the external side', async () => {
            const taskId = randomUUID();
            await links.create(scope, {
                entityType: 'task',
                entityId: taskId,
                externalId: 'g-1',
                externalUrl: 'https://app.gauzy.co/#/tasks/g-1',
            });
            const found = await links.findByExternal(scope, 'task', 'g-1');
            expect(found?.entityId).toBe(taskId);
            expect(toExternalRecordLinkDto(found!)).toMatchObject({
                organizationId: ORG_A,
                entityType: 'task',
                entityId: taskId,
                source: 'gauzy',
                installationId: 'conn-1',
                externalId: 'g-1',
                externalUrl: 'https://app.gauzy.co/#/tasks/g-1',
            });
            // Another installation or organization is another namespace.
            expect(
                await links.findByExternal({ ...scope, installationId: 'conn-2' }, 'task', 'g-1'),
            ).toBeNull();
            expect(
                await links.findByExternal({ ...scope, organizationId: ORG_B }, 'task', 'g-1'),
            ).toBeNull();
        });

        it('is unique on both sides, per organization, source and installation', async () => {
            const [a, b] = [randomUUID(), randomUUID()];
            await links.create(scope, { entityType: 'task', entityId: a, externalId: 'g-1' });
            await expect(
                links.create(scope, { entityType: 'task', entityId: b, externalId: 'g-1' }),
            ).rejects.toMatchObject({
                name: 'DuplicateExternalRefError',
                side: 'external',
                existingEntityId: a,
            });
            await expect(
                links.create(scope, { entityType: 'task', entityId: a, externalId: 'g-2' }),
            ).rejects.toBeInstanceOf(DuplicateExternalRefError);
            // No installation is a namespace of its own, and still unique ('' never NULL).
            const none = { ...scope, installationId: null };
            await links.create(none, { entityType: 'task', entityId: b, externalId: 'g-1' });
            await expect(
                links.create(none, {
                    entityType: 'task',
                    entityId: randomUUID(),
                    externalId: 'g-1',
                }),
            ).rejects.toBeInstanceOf(DuplicateExternalRefError);
            const [row] = await links.list(
                { organizationId: ORG_A, source: 'gauzy' },
                { entityId: b },
            );
            expect(toExternalRecordLinkDto(row).installationId).toBeNull();
        });

        it('PUT sets or moves a record link; DELETE removes it', async () => {
            const taskId = randomUUID();
            await links.put(scope, { entityType: 'task', entityId: taskId, externalId: 'g-1' });
            await links.put(scope, {
                entityType: 'task',
                entityId: taskId,
                externalId: 'g-9',
                externalUrl: null,
            });
            expect((await links.findByExternal(scope, 'task', 'g-9'))?.entityId).toBe(taskId);
            expect(await links.findByExternal(scope, 'task', 'g-1')).toBeNull();
            expect(await links.remove(scope, 'task', taskId)).toBe(1);
            expect(await dataSource.getRepository(ExternalRecordLink).count()).toBe(0);
        });

        it('groups externalLinks of a page of records for the caller source', async () => {
            const [a, b] = [randomUUID(), randomUUID()];
            await links.create(scope, { entityType: 'task', entityId: a, externalId: 'g-1' });
            await links.create(
                { ...scope, installationId: 'conn-2' },
                { entityType: 'task', entityId: a, externalId: 'g-1' },
            );
            await links.create(
                { ...scope, source: 'jira' },
                { entityType: 'task', entityId: b, externalId: 'J-1' },
            );
            const byEntity = await links.linksFor(ORG_A, 'task', [a, b], 'gauzy');
            expect(
                byEntity
                    .get(a)
                    ?.map((link) => link.installationId)
                    .sort(),
            ).toEqual(['conn-1', 'conn-2']);
            expect(byEntity.has(b)).toBe(false);
            // Org-scoped: the same record id in another organization is another link set.
            expect((await links.linksFor(ORG_B, 'task', [a], 'gauzy')).has(a)).toBe(false);
        });

        it('removes a record links in ONE organization only', async () => {
            const memberId = randomUUID();
            await links.create(scope, {
                entityType: 'member',
                entityId: memberId,
                externalId: 'emp-1',
            });
            await links.create(
                { ...scope, organizationId: ORG_B },
                { entityType: 'member', entityId: memberId, externalId: 'emp-9' },
            );
            expect(await links.removeAllFor(ORG_A, 'member', memberId)).toBe(1);
            expect(
                await links.findByExternal({ ...scope, organizationId: ORG_B }, 'member', 'emp-9'),
            ).not.toBeNull();
        });

        it('reports which side collides before inserting (safe inside a Postgres transaction)', async () => {
            const [a, b] = [randomUUID(), randomUUID()];
            await links.create(scope, { entityType: 'task', entityId: a, externalId: 'g-1' });
            await expect(
                dataSource.transaction((manager) =>
                    links.create(
                        scope,
                        { entityType: 'task', entityId: a, externalId: 'g-2' },
                        manager,
                    ),
                ),
            ).rejects.toMatchObject({
                side: 'entity',
                existingEntityId: a,
                existingExternalId: 'g-1',
            });
            await expect(
                links.put(scope, { entityType: 'task', entityId: b, externalId: 'g-1' }),
            ).rejects.toMatchObject({ side: 'external', existingEntityId: a });
        });

        it('takes the installation from X-Sync-Origin when externalRef has none', () => {
            expect(installationFromOrigin('explicit', 'gauzy:conn-1', 'gauzy')).toBe('explicit');
            expect(installationFromOrigin(null, 'gauzy:conn-1', 'gauzy')).toBe('conn-1');
            expect(installationFromOrigin(undefined, 'jira:x', 'gauzy')).toBeNull();
            expect(installationFromOrigin(null, 'gauzy:', 'gauzy')).toBeNull();
            expect(installationFromOrigin(null, null, 'gauzy')).toBeNull();
        });
    });

    describe('Idempotency-Key store', () => {
        const hash = idempotencyRequestHash('POST', '/api/integrations/v1/tasks', { title: 'x' });

        it('runs once and replays the stored response for the same request', async () => {
            const work = jest.fn().mockResolvedValue({ status: 201, body: { id: 't-1' } });
            const first = await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash },
                work,
            );
            const second = await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash },
                work,
            );
            expect(first).toEqual({ status: 201, body: { id: 't-1' }, replayed: false });
            expect(second).toEqual({ status: 201, body: { id: 't-1' }, replayed: true });
            expect(work).toHaveBeenCalledTimes(1);
            // Keys are per integration key.
            await idempotency.run(
                { integrationKeyId: randomUUID(), idempotencyKey: 'k-1', requestHash: hash },
                work,
            );
            expect(work).toHaveBeenCalledTimes(2);
        });

        it('refuses the same key with another request, and while the first still runs', async () => {
            await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash },
                async () => ({ status: 201, body: {} }),
            );
            const other = idempotencyRequestHash('POST', '/api/integrations/v1/tasks', {
                title: 'y',
            });
            await expect(
                idempotency.run(
                    { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: other },
                    async () => ({ status: 201, body: {} }),
                ),
            ).rejects.toMatchObject({ reason: 'request_mismatch' });

            let release!: () => void;
            const slow = idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-2', requestHash: hash },
                () =>
                    new Promise((resolve) => {
                        release = () => resolve({ status: 201, body: { id: 'slow' } });
                    }),
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            await expect(
                idempotency.run(
                    { integrationKeyId: KEY, idempotencyKey: 'k-2', requestHash: hash },
                    async () => ({ status: 201, body: {} }),
                ),
            ).rejects.toBeInstanceOf(IdempotencyConflictError);
            release();
            await expect(slow).resolves.toMatchObject({ body: { id: 'slow' } });
        });

        it('releases the key when the work throws or answers 5xx, so a retry can succeed', async () => {
            await expect(
                idempotency.run(
                    { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash },
                    async () => {
                        throw new Error('boom');
                    },
                ),
            ).rejects.toThrow('boom');
            await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash },
                async () => ({ status: 503, body: {} }),
            );
            const ok = await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash },
                async () => ({ status: 201, body: { id: 'ok' } }),
            );
            expect(ok).toEqual({ status: 201, body: { id: 'ok' }, replayed: false });
        });

        it('frees a claim left in progress by a request that died', async () => {
            await dataSource.getRepository(IntegrationIdempotencyKey).insert({
                integrationKeyId: KEY,
                idempotencyKey: 'k-stale',
                requestHash: hash,
                state: 'in_progress',
                expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
            } as unknown as IntegrationIdempotencyKey);
            // Still fresh: refused.
            await expect(
                idempotency.run(
                    { integrationKeyId: KEY, idempotencyKey: 'k-stale', requestHash: hash },
                    async () => ({ status: 201, body: {} }),
                ),
            ).rejects.toBeInstanceOf(IdempotencyConflictError);
            // Six minutes later the dead claim is replaced.
            const later = new Date(Date.now() + 6 * 60 * 1000);
            const result = await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-stale', requestHash: hash, now: later },
                async () => ({ status: 201, body: { id: 'retried' } }),
            );
            expect(result).toEqual({ status: 201, body: { id: 'retried' }, replayed: false });
        });

        it('forgets responses after 24 h and purges them', async () => {
            const past = new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000);
            await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash, now: past },
                async () => ({ status: 201, body: { id: 'old' } }),
            );
            const fresh = await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-1', requestHash: hash },
                async () => ({ status: 201, body: { id: 'new' } }),
            );
            expect(fresh).toMatchObject({ body: { id: 'new' }, replayed: false });
            await idempotency.run(
                { integrationKeyId: KEY, idempotencyKey: 'k-2', requestHash: hash, now: past },
                async () => ({ status: 201, body: {} }),
            );
            expect(await idempotency.purgeExpired()).toBe(1);
            expect(await dataSource.getRepository(IntegrationIdempotencyKey).count()).toBe(1);
        });
    });

    describe('keyset paging', () => {
        it('round-trips cursors and refuses foreign ones', () => {
            for (const updatedAt of [
                '2026-10-16 05:00:00.123',
                '2026-10-16 05:00:00.123456',
                '2026-10-16 05:00:00',
            ]) {
                const position = { updatedAt, id: 'abc' };
                expect(decodeKeysetCursor(encodeKeysetCursor(position))).toEqual(position);
            }
            const forged = (value: unknown) =>
                Buffer.from(JSON.stringify(value)).toString('base64url');
            for (const bad of [
                '',
                'not-base64!',
                forged({ v: 2 }),
                forged({ v: 1, u: 1e20, i: 'abc' }),
                forged({ v: 1, u: '2026-13-99 99:99', i: 'abc' }),
                forged({ v: 1, u: '2026-10-16 05:00:00', i: '' }),
                forged(null),
            ]) {
                expect(() => decodeKeysetCursor(bad)).toThrow(InvalidCursorError);
            }
            expect(keysetLimit(undefined)).toBe(200);
            expect(keysetLimit(Number.NaN)).toBe(200);
            expect(keysetLimit(0)).toBe(1);
            expect(keysetLimit(10_000)).toBe(500);
        });

        it('pages by (updatedAt, id) losslessly, ties included', async () => {
            const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 5, 0, s));
            const ids = [
                '00000000-0000-4000-8000-00000000000a',
                '00000000-0000-4000-8000-00000000000b',
                '00000000-0000-4000-8000-00000000000c',
                '00000000-0000-4000-8000-00000000000d',
                '00000000-0000-4000-8000-00000000000e',
            ];
            const times = [at(1), at(2), at(2), at(2), at(3)];
            for (let i = 0; i < ids.length; i++) {
                await dataSource.getRepository(Team).insert({
                    id: ids[i],
                    userId: randomUUID(),
                    name: `T${i}`,
                    slug: `t${i}`,
                    organizationId: ORG_A,
                } as unknown as Team);
                await dataSource.query(`UPDATE "teams" SET "updatedAt" = ? WHERE "id" = ?`, [
                    times[i].toISOString().replace('T', ' ').replace('Z', ''),
                    ids[i],
                ]);
            }
            const seen: string[] = [];
            let cursor: string | null = null;
            let pages = 0;
            do {
                const page = await readKeysetPage(
                    dataSource
                        .getRepository(Team)
                        .createQueryBuilder('team')
                        .where('team.organizationId = :org', { org: ORG_A }),
                    'team',
                    { cursor, limit: 2 },
                );
                seen.push(...page.data.map((team) => team.id));
                cursor = page.nextCursor;
                pages += 1;
            } while (cursor && pages < 10);
            expect(seen).toEqual(ids);
            expect(pages).toBe(3);

            const since = await readKeysetPage(
                dataSource.getRepository(Team).createQueryBuilder('team'),
                'team',
                { updatedSince: at(2), limit: 10 },
            );
            expect(since.data.map((team) => team.id)).toEqual(ids.slice(1));
            expect(since).toMatchObject({ hasMore: false, nextCursor: null });
        });
    });

    describe('If-Match', () => {
        it('parses the versions this API issues and ignores no-precondition values', () => {
            expect(etagFor(17)).toBe('"17"');
            expect(parseIfMatch('"17"')).toBe(17);
            expect(parseIfMatch('W/"17"')).toBe(17);
            expect(parseIfMatch('17')).toBe(17);
            expect(parseIfMatch(['"3"', '"4"'])).toBe(3);
            expect(parseIfMatch(undefined)).toBeNull();
            expect(parseIfMatch('*')).toBeNull();
            expect(parseIfMatch('"abc"')).toBeUndefined();
        });

        it('412s a stale version and passes a current or absent one', () => {
            expect(() => assertIfMatch(3, 4)).toThrow(VersionMismatchError);
            try {
                assertIfMatch(3, 4);
            } catch (error) {
                expect(error).toMatchObject({ expected: 3, current: 4 });
            }
            expect(() => assertIfMatch(4, 4)).not.toThrow();
            expect(() => assertIfMatch(null, 4)).not.toThrow();
        });
    });
});
