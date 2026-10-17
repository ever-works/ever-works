import { DataSource } from 'typeorm';
import { AddWebhookSubscriptionsV21795080100000 } from '../1795080100000-AddWebhookSubscriptionsV2';

/**
 * Migration test for webhooks v2 (EW-P1-5) on in-memory better-sqlite3,
 * asserting the PHYSICAL schema through `PRAGMA`. The two webhook tables are
 * created the way 1779900000000 / 1779950000000 left them (just the columns
 * the assertions need), with one existing row each.
 */
describe('AddWebhookSubscriptionsV21795080100000', () => {
    let dataSource: DataSource;
    const migration = new AddWebhookSubscriptionsV21795080100000();

    const columns = async (
        table: string,
    ): Promise<Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>> =>
        dataSource.query(`PRAGMA table_info("${table}")`);
    const indexes = async (table: string): Promise<Array<{ name: string; unique: number }>> =>
        dataSource.query(`PRAGMA index_list("${table}")`);
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "webhook_subscriptions" ("id" varchar PRIMARY KEY NOT NULL, "accountId" varchar NOT NULL, "url" varchar NOT NULL, "secretEncrypted" text NOT NULL, "status" varchar NOT NULL DEFAULT ('active'))`,
        );
        await dataSource.query(
            `INSERT INTO "webhook_subscriptions" ("id", "accountId", "url", "secretEncrypted") VALUES ('sub-1', 'acct-1', 'https://x', 'enc')`,
        );
        await dataSource.query(
            `CREATE TABLE "webhook_deliveries" ("id" varchar PRIMARY KEY NOT NULL, "subscriptionId" varchar NOT NULL, "event" varchar NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "webhook_deliveries" ("id", "subscriptionId", "event") VALUES ('dlv-1', 'sub-1', 'work.created')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the v2 subscription columns; existing rows become version 1, user-owned', async () => {
        await run('up');
        const names = (await columns('webhook_subscriptions')).map((c) => c.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'version',
                'ownerType',
                'ownerId',
                'events',
                'organizationIds',
                'excludeOriginTags',
                'startAfterSeq',
                'description',
                'previousSecretEncrypted',
                'previousSecretExpiresAt',
            ]),
        );
        const [row] = await dataSource.query(
            `SELECT "version", "ownerType", "ownerId", "events" FROM "webhook_subscriptions"`,
        );
        expect(row).toEqual({ version: 1, ownerType: 'user', ownerId: null, events: null });
        expect((await indexes('webhook_subscriptions')).map((i) => i.name)).toContain(
            'idx_webhook_subscriptions_version_status',
        );
    });

    it('adds deliveries.eventId with a unique (subscriptionId, eventId) index that lets NULLs repeat', async () => {
        await run('up');
        expect((await columns('webhook_deliveries')).map((c) => c.name)).toContain('eventId');
        const unique = (await indexes('webhook_deliveries')).find(
            (i) => i.name === 'uq_webhook_deliveries_subscription_event',
        );
        expect(unique?.unique).toBe(1);

        // v1 rows (eventId NULL) never collide …
        await dataSource.query(
            `INSERT INTO "webhook_deliveries" ("id", "subscriptionId", "event") VALUES ('dlv-2', 'sub-1', 'work.created')`,
        );
        // … one delivery per (subscription, domain event).
        await dataSource.query(
            `INSERT INTO "webhook_deliveries" ("id", "subscriptionId", "event", "eventId") VALUES ('dlv-3', 'sub-1', 'task.updated', 'evt_1')`,
        );
        await expect(
            dataSource.query(
                `INSERT INTO "webhook_deliveries" ("id", "subscriptionId", "event", "eventId") VALUES ('dlv-4', 'sub-1', 'task.updated', 'evt_1')`,
            ),
        ).rejects.toThrow(/UNIQUE/i);
    });

    it('is idempotent', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
        expect(
            (await columns('webhook_subscriptions')).filter((c) => c.name === 'version'),
        ).toHaveLength(1);
    });

    it('down removes exactly what up added', async () => {
        const before = {
            subs: (await columns('webhook_subscriptions')).map((c) => c.name),
            deliveries: (await columns('webhook_deliveries')).map((c) => c.name),
        };
        await run('up');
        await run('down');
        expect((await columns('webhook_subscriptions')).map((c) => c.name)).toEqual(before.subs);
        expect((await columns('webhook_deliveries')).map((c) => c.name)).toEqual(before.deliveries);
        const [row] = await dataSource.query(`SELECT "id" FROM "webhook_subscriptions"`);
        expect(row).toEqual({ id: 'sub-1' });
    });
});
