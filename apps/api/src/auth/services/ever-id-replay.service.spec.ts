import { DataSource } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { AuthVerification } from '@ever-works/agent/entities';
import { EverIdReplayService } from './ever-id-replay.service';

/**
 * APW-12 (Ever ID) — single use on the existing `verification` table (plan §3.3,
 * NFR-7): the second consumer of a value loses, concurrently too, and only
 * digests are stored.
 */
describe('EverIdReplayService', () => {
    let dataSource: DataSource;
    let replay: EverIdReplayService;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        replay = new EverIdReplayService(dataSource);
    });
    afterAll(async () => dataSource.destroy());
    beforeEach(async () => dataSource.getRepository(AuthVerification).clear());

    it('answers true for the first use and false for every later one', async () => {
        expect(await replay.consumeOnce('txn', 'state-1', 600)).toBe(true);
        expect(await replay.consumeOnce('txn', 'state-1', 600)).toBe(false);
        // Namespaces are separate.
        expect(await replay.consumeOnce('pending', 'state-1', 600)).toBe(true);
    });

    it('leaves exactly one winner among concurrent consumers (NFR-7)', async () => {
        const results = await Promise.all(
            Array.from({ length: 5 }, () => replay.consumeOnce('logout-jti', 'iss|jti-1', 600)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('stores a digest, never the value', async () => {
        await replay.consumeOnce('session-jti', 'https://id.example.test|jti-secret-value', 600);
        const rows = await dataSource.getRepository(AuthVerification).find();

        expect(rows).toHaveLength(1);
        expect(rows[0].identifier).toBe('ever-id:session-jti');
        expect(rows[0].value).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(rows)).not.toContain('jti-secret-value');
        expect(
            await replay.wasUsed('session-jti', 'https://id.example.test|jti-secret-value'),
        ).toBe(true);
    });

    it('sweeps expired Ever ID rows and leaves every other verification row alone', async () => {
        const past = new Date(Date.now() - 60_000);
        await dataSource.getRepository(AuthVerification).insert([
            { id: 'old-1', identifier: 'ever-id:txn', value: 'v-old-1', expiresAt: past },
            { id: 'old-2', identifier: 'ever-id:pending', value: 'v-old-2', expiresAt: past },
            { id: 'other', identifier: 'email-verification', value: 'v-other', expiresAt: past },
        ]);

        await replay.consumeOnce('txn', 'fresh', 600);

        const ids = (await dataSource.getRepository(AuthVerification).find())
            .map((row) => row.id)
            .sort();
        expect(ids).toContain('other');
        expect(ids).not.toContain('old-1');
        expect(ids).not.toContain('old-2');
    });

    it('marks a session as signed out by Ever ID and reads the mark back (S6)', async () => {
        await replay.markSignedOut(['hash-a', 'hash-a', 'hash-b']);

        expect(await replay.isSignedOut('hash-a')).toBe(true);
        expect(await replay.isSignedOut('hash-b')).toBe(true);
        expect(await replay.isSignedOut('hash-c')).toBe(false);
        expect(await replay.isSignedOut('')).toBe(false);
        // A second notice for the same session is harmless.
        await expect(replay.markSignedOut(['hash-a'])).resolves.toBeUndefined();
    });
});
