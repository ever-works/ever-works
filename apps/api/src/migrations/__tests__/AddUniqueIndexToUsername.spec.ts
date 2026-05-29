import { DataSource } from 'typeorm';
import { AddUniqueIndexToUsername1779991000000 } from '../1779991000000-AddUniqueIndexToUsername';

/**
 * EW-652 — migration test for the case-insensitive UNIQUE index on
 * `users.username`, plus the auto-rename dedup path that landed after
 * the 2026-05-28 prod incident (CrashLoopBackOff on two real users
 * sharing username `paradoxe35`).
 *
 * Uses the same in-memory better-sqlite3 harness as
 * `AddWorkKindAndStatus.spec.ts`. Asserts:
 *   - clean DB → index is created, no renames.
 *   - case-insensitive duplicate bucket → oldest row keeps the canonical
 *     username; later rows get `-<id-prefix>` suffix; index is then
 *     created successfully.
 *   - multi-bucket + 3-way collision → all extras renamed correctly.
 *   - idempotent: running up() twice does not throw.
 *   - down() drops the index.
 */
describe('AddUniqueIndexToUsername1779991000000 (EW-652)', () => {
    let dataSource: DataSource;
    const migration = new AddUniqueIndexToUsername1779991000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        await dataSource.query(
            `CREATE TABLE "users" (
                "id" varchar PRIMARY KEY NOT NULL,
                "username" varchar,
                "createdAt" varchar NOT NULL
            )`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    function uuid(prefix: string): string {
        // Stable 36-char UUID-ish string keyed on prefix so tests assert on
        // the suffix the migration produces from substring(id, 1, 6).
        return `${prefix}aa-bbbb-cccc-dddd-eeeeeeeeeeee`.slice(0, 36);
    }

    async function insert(id: string, username: string | null, createdAt: string): Promise<void> {
        await dataSource.query(
            `INSERT INTO "users" ("id", "username", "createdAt") VALUES (?, ?, ?)`,
            [id, username, createdAt],
        );
    }

    async function usernamesById(): Promise<Record<string, string | null>> {
        const rows: Array<{ id: string; username: string | null }> = await dataSource.query(
            `SELECT "id", "username" FROM "users"`,
        );
        return Object.fromEntries(rows.map((r) => [r.id, r.username]));
    }

    async function indexExists(): Promise<boolean> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_username_lower_unique'`,
        );
        return rows.length === 1;
    }

    it('creates the unique index on a clean DB', async () => {
        await insert(uuid('111111'), 'alice', '2026-01-01');
        await insert(uuid('222222'), 'bob', '2026-01-02');

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        expect(await indexExists()).toBe(true);
    });

    it('auto-renames case-insensitive duplicates: oldest keeps canonical name', async () => {
        const oldId = uuid('aaaaaa');
        const newId = uuid('bbbbbb');
        await insert(oldId, 'paradoxe35', '2025-09-25T14:56:57Z');
        await insert(newId, 'paradoxe35', '2026-04-13T08:00:25Z');

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const after = await usernamesById();
        expect(after[oldId]).toBe('paradoxe35');
        expect(after[newId]).toBe('paradoxe35-bbbbbb');
        expect(await indexExists()).toBe(true);
    });

    it('handles 3-way + multi-bucket duplicates', async () => {
        // Bucket A: 3 rows
        await insert(uuid('aaaaaa'), 'alice', '2026-01-01');
        await insert(uuid('bbbbbb'), 'alice', '2026-02-01');
        await insert(uuid('cccccc'), 'Alice', '2026-03-01');
        // Bucket B: 2 rows, case-mixed
        await insert(uuid('dddddd'), 'Bob', '2026-01-15');
        await insert(uuid('eeeeee'), 'bob', '2026-02-15');
        // Unrelated row
        await insert(uuid('ffffff'), 'carol', '2026-01-10');

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const after = await usernamesById();
        expect(after[uuid('aaaaaa')]).toBe('alice');
        expect(after[uuid('bbbbbb')]).toBe('alice-bbbbbb');
        expect(after[uuid('cccccc')]).toBe('Alice-cccccc');
        expect(after[uuid('dddddd')]).toBe('Bob');
        expect(after[uuid('eeeeee')]).toBe('bob-eeeeee');
        expect(after[uuid('ffffff')]).toBe('carol');
        expect(await indexExists()).toBe(true);
    });

    it('is idempotent — running up() twice does not throw', async () => {
        await insert(uuid('111111'), 'alice', '2026-01-01');
        await insert(uuid('222222'), 'alice', '2026-02-01');

        const r1 = dataSource.createQueryRunner();
        await migration.up(r1);
        await r1.release();

        const r2 = dataSource.createQueryRunner();
        await expect(migration.up(r2)).resolves.toBeUndefined();
        await r2.release();

        expect(await indexExists()).toBe(true);
    });

    it('falls back to longer id-prefix when rename target collides with existing user', async () => {
        // A prior manual cleanup already produced `paradoxe35-bbbbbb` — the
        // exact name the 6-char suffix would otherwise generate. The
        // migration must avoid collision instead of throwing.
        const oldId = uuid('aaaaaa');
        const newId = uuid('bbbbbb');
        const collidingId = uuid('999999');
        await insert(oldId, 'paradoxe35', '2025-09-25');
        await insert(newId, 'paradoxe35', '2026-04-13');
        await insert(collidingId, 'paradoxe35-bbbbbb', '2026-04-14');

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const after = await usernamesById();
        expect(after[oldId]).toBe('paradoxe35');
        expect(after[collidingId]).toBe('paradoxe35-bbbbbb');
        // newId's rename target collided → migration extends suffix until free.
        expect(after[newId]).not.toBe('paradoxe35');
        expect(after[newId]).not.toBe('paradoxe35-bbbbbb');
        expect(after[newId]).toMatch(/^paradoxe35-bbbbbb[a-z0-9]+/);
        expect(await indexExists()).toBe(true);
    });

    it('down() drops the index', async () => {
        await insert(uuid('111111'), 'alice', '2026-01-01');

        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();
        expect(await indexExists()).toBe(true);

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();
        expect(await indexExists()).toBe(false);
    });
});
