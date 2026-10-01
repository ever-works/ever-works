import { DataSource } from 'typeorm';
import { ExternalIdentity } from '../../../entities/external-identity.entity';
import { User } from '../../../entities/user.entity';
import { ENTITIES } from '../../_entities-inventory';
import {
    EXTERNAL_IDENTITY_DELEGATED_CLIENTS_MAX,
    ExternalIdentityConflictError,
    ExternalIdentityRepository,
} from '../external-identity.repository';

/**
 * APW-12 (Ever ID) — the connected-identity repository against a real
 * (in-memory better-sqlite3) database, so the two unique constraints and the
 * cascade are the ones the schema declares, not a mock of them.
 *
 * Spec FR-21 (one account per pair, one pair per account per issuer), FR-22
 * (the pair — never an e-mail — selects the account), FR-31/FR-48 (at most 10
 * delegated clients, oldest evicted), FR-30 / ACC-12-41 (deleting an account
 * deletes its identities; replaying the deletion is a no-op), S24 / ACC-12-19
 * (concurrent inserts of one pair leave exactly one row).
 *
 * Every id below is synthetic and every address uses a reserved example domain.
 */

const ISSUER = 'https://id.example.test';
const OTHER_ISSUER = 'https://id-next.example.test';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('ExternalIdentityRepository', () => {
    let dataSource: DataSource;
    let identities: ExternalIdentityRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        identities = new ExternalIdentityRepository(dataSource.getRepository(ExternalIdentity));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(ExternalIdentity).clear();
        await dataSource.query('DELETE FROM "users"');
        await dataSource.query('PRAGMA foreign_keys = ON');
        for (const [id, name] of [
            [ALICE, 'alice'],
            [BOB, 'bob'],
        ] as const) {
            await dataSource.getRepository(User).insert({
                id,
                username: name,
                slug: name,
                email: `${name}@example.com`,
                password: 'not-a-real-hash',
                registrationProvider: 'local',
                isActive: true,
            } as Partial<User>);
        }
    });

    const link = (userId: string, subject: string, issuer = ISSUER) =>
        identities.insertLink({
            userId,
            issuer,
            subject,
            emailAtLink: 'person@example.com',
            emailVerifiedAtLink: true,
            linkedVia: 'settings',
        });

    it('creates one row per pair and finds it by the pair', async () => {
        const created = await link(ALICE, 'subject-a');

        expect(created.id).toEqual(expect.any(String));
        const found = await identities.findByIssuerSubject(ISSUER, 'subject-a');
        expect(found?.userId).toBe(ALICE);
        expect(found?.linkedVia).toBe('settings');
        expect(found?.lastLoginAt ?? null).toBeNull();
        expect(await identities.existsForIssuer(ISSUER)).toBe(true);
        expect(await identities.existsForIssuer(OTHER_ISSUER)).toBe(false);
    });

    it('refuses a pair connected to another account with `subjectLinked` (S12)', async () => {
        await link(ALICE, 'subject-a');

        await expect(link(BOB, 'subject-a')).rejects.toEqual(
            new ExternalIdentityConflictError('subjectLinked'),
        );
        expect(await dataSource.getRepository(ExternalIdentity).count()).toBe(1);
    });

    it('refuses a second pair of the same issuer on one account with `userHasIssuer` (S13)', async () => {
        await link(ALICE, 'subject-a');

        await expect(link(ALICE, 'subject-b')).rejects.toEqual(
            new ExternalIdentityConflictError('userHasIssuer'),
        );
        // Another issuer is fine (FR-21: one pair per account PER ISSUER).
        await expect(link(ALICE, 'subject-b', OTHER_ISSUER)).resolves.toBeDefined();
    });

    it('leaves exactly one row when the same pair is inserted concurrently (S24, ACC-12-19)', async () => {
        const results = await Promise.allSettled([link(ALICE, 'race'), link(BOB, 'race')]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(
            (result) => result.status === 'rejected',
        ) as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(ExternalIdentityConflictError);
        expect(
            await dataSource.getRepository(ExternalIdentity).count({ where: { subject: 'race' } }),
        ).toBe(1);
    });

    it('lists an account’s identities and deletes only that account’s row', async () => {
        const mine = await link(ALICE, 'subject-a');
        const theirs = await link(BOB, 'subject-b');

        expect((await identities.listForUser(ALICE)).map((row) => row.id)).toEqual([mine.id]);
        // Somebody else's id is "not found" for this account — and untouched.
        expect(await identities.deleteForUser(theirs.id, ALICE)).toBe(false);
        expect(await identities.findById(theirs.id)).not.toBeNull();
        expect(await identities.deleteForUser(mine.id, ALICE)).toBe(true);
        expect(await identities.listForUser(ALICE)).toEqual([]);
    });

    it('records a sign-in time', async () => {
        const row = await link(ALICE, 'subject-a');
        const at = new Date('2026-09-01T10:00:00.000Z');

        await identities.touchLogin(row.id, at);

        expect((await identities.findById(row.id))?.lastLoginAt?.toISOString()).toBe(
            at.toISOString(),
        );
    });

    it('remembers at most 10 delegated clients, newest first, one entry per client (FR-31, FR-48)', async () => {
        const row = await link(ALICE, 'subject-a');
        const base = Date.parse('2026-09-01T00:00:00.000Z');

        for (let index = 0; index < EXTERNAL_IDENTITY_DELEGATED_CLIENTS_MAX + 2; index += 1) {
            await identities.recordDelegatedClient(
                row.id,
                `client-${index}`,
                new Date(base + index * 1000),
            );
        }
        // A repeat read moves the client to the front instead of adding a row.
        await identities.recordDelegatedClient(row.id, 'client-5', new Date(base + 60_000));

        const clients = (await identities.findById(row.id))?.delegatedClients ?? [];
        expect(clients).toHaveLength(EXTERNAL_IDENTITY_DELEGATED_CLIENTS_MAX);
        expect(clients[0].clientId).toBe('client-5');
        expect(clients.map((client) => client.clientId)).not.toContain('client-0');
        expect(clients.map((client) => client.clientId)).not.toContain('client-1');
        expect(new Set(clients.map((client) => client.clientId)).size).toBe(clients.length);
    });

    it('answers "first read in 24 hours" exactly once per client per window (FR-49)', async () => {
        const row = await link(ALICE, 'subject-a');
        const t0 = new Date('2026-09-01T00:00:00.000Z');

        expect(await identities.recordDelegatedClient(row.id, 'launcher', t0)).toEqual({
            firstInWindow: true,
        });
        expect(
            await identities.recordDelegatedClient(
                row.id,
                'launcher',
                new Date(t0.getTime() + 60_000),
            ),
        ).toEqual({ firstInWindow: false });
        expect(
            await identities.recordDelegatedClient(
                row.id,
                'launcher',
                new Date(t0.getTime() + 25 * 60 * 60 * 1000),
            ),
        ).toEqual({ firstInWindow: true });
    });

    it('deletes every identity of a deleted account, and a replayed deletion is a no-op (FR-30, ACC-12-41)', async () => {
        await link(ALICE, 'subject-a');
        await link(ALICE, 'subject-a2', OTHER_ISSUER);
        await link(BOB, 'subject-b');

        await dataSource.getRepository(User).delete({ id: ALICE });
        await dataSource.getRepository(User).delete({ id: ALICE });

        expect(await identities.listForUser(ALICE)).toEqual([]);
        expect(await identities.listForUser(BOB)).toHaveLength(1);
    });

    it('never stores a token: the row has exactly the FR-31 fields', async () => {
        const row = await link(ALICE, 'subject-a');
        const raw = (
            await dataSource.query('SELECT * FROM "external_identities" WHERE "id" = ?', [row.id])
        )[0];

        expect(Object.keys(raw).sort()).toEqual(
            [
                'createdAt',
                'delegatedClients',
                'emailAtLink',
                'emailVerifiedAtLink',
                'id',
                'issuer',
                'lastLoginAt',
                'linkedAt',
                'linkedVia',
                'subject',
                'tenantId',
                'updatedAt',
                'userId',
            ].sort(),
        );
    });
});
