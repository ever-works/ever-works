import { DataSource } from 'typeorm';
import { AddFleetCredentialRotation1789000000000 } from '../1789000000000-AddFleetCredentialRotation';

/**
 * Migration test for the fleet credential rotation columns (EW-799).
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters:
 *
 *  - all four columns land NULL on existing rows. A node that predates
 *    the feature has no previous credential and no queued rotation, and a
 *    non-NULL default would be a lie about both — worse, a non-NULL
 *    `previousCredentialHash` would be a second credential nobody minted;
 *  - the previous-credential hash is NOT part of the UNIQUE credential
 *    index. That index is what `enroll` resolves rows by, so a valid old
 *    hash reachable from it would be a replayable enrollment token — the
 *    single most dangerous way to get this feature wrong;
 *  - `up()` is idempotent (a partially-applied database converges);
 *  - `down()` reverses all of it.
 */
describe('AddFleetCredentialRotation1789000000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetCredentialRotation1789000000000();

    const runUp = async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    };

    const runDown = async () => {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL,
                "enrollmentTokenHash" varchar,
                "credentialIssuedAt" datetime
            )
        `);
        await dataSource.query(
            `CREATE UNIQUE INDEX "idx_fleet_nodes_credential" ON "fleet_nodes" ("enrollmentTokenHash")`,
        );
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status", "enrollmentTokenHash", "credentialIssuedAt")
             VALUES ('n1', 'u1', 'laptop', 'desktop-node', 'online', 'hash-current', '2026-09-05 10:00:00.000')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the four rotation columns and leaves existing rows NULL', async () => {
        await runUp();

        const rows = await dataSource.query(
            `SELECT "previousCredentialHash", "previousCredentialExpiresAt", "rotationRequestedAt",
                    "rotationRequestedByUserId", "enrollmentTokenHash"
             FROM "fleet_nodes"`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].previousCredentialHash).toBeNull();
        expect(rows[0].previousCredentialExpiresAt).toBeNull();
        expect(rows[0].rotationRequestedAt).toBeNull();
        expect(rows[0].rotationRequestedByUserId).toBeNull();
        // The live credential is untouched — this migration is additive.
        expect(rows[0].enrollmentTokenHash).toBe('hash-current');
    });

    it('keeps the previous-credential hash out of the UNIQUE credential index', async () => {
        await runUp();

        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('fleet_nodes');
        await runner.release();

        const credentialIndex = table?.indices.find(
            (index) => index.name === 'idx_fleet_nodes_credential',
        );
        expect(credentialIndex?.isUnique).toBe(true);
        expect(credentialIndex?.columnNames).toEqual(['enrollmentTokenHash']);
        // No index of any kind covers the previous hash: it is written and
        // read by node id only, never looked up by value, which is what
        // stops a live old credential from being a redeemable enrollment
        // token via `findByCredentialHash`.
        for (const index of table?.indices ?? []) {
            expect(index.columnNames).not.toContain('previousCredentialHash');
        }
    });

    it('allows two nodes to share a previous-credential hash (it is not unique)', async () => {
        await runUp();

        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status", "enrollmentTokenHash")
             VALUES ('n2', 'u1', 'desktop', 'node', 'online', 'hash-other')`,
        );
        await dataSource.query(
            `UPDATE "fleet_nodes" SET "previousCredentialHash" = 'shared-old-hash'`,
        );

        const rows = await dataSource.query(
            `SELECT "id" FROM "fleet_nodes" WHERE "previousCredentialHash" = 'shared-old-hash' ORDER BY "id"`,
        );
        expect(rows.map((row: { id: string }) => row.id)).toEqual(['n1', 'n2']);
    });

    it('is idempotent: a re-run neither throws nor loses data', async () => {
        await runUp();
        await dataSource.query(
            `UPDATE "fleet_nodes" SET "rotationRequestedAt" = '2026-09-05 11:00:00.000',
                                     "rotationRequestedByUserId" = 'u1'`,
        );

        await expect(runUp()).resolves.not.toThrow();

        const rows = await dataSource.query(
            `SELECT "rotationRequestedAt", "rotationRequestedByUserId" FROM "fleet_nodes"`,
        );
        expect(rows[0].rotationRequestedByUserId).toBe('u1');
        expect(rows[0].rotationRequestedAt).toBe('2026-09-05 11:00:00.000');
    });

    it('down removes all four columns', async () => {
        await runUp();
        await runDown();

        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('fleet_nodes');
        await runner.release();

        for (const column of [
            'previousCredentialHash',
            'previousCredentialExpiresAt',
            'rotationRequestedAt',
            'rotationRequestedByUserId',
        ]) {
            expect(table?.findColumnByName(column)).toBeUndefined();
        }
        // The row itself survives the reversal.
        const rows = await dataSource.query(`SELECT "id" FROM "fleet_nodes"`);
        expect(rows).toEqual([{ id: 'n1' }]);
    });
});
