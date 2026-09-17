import { DataSource } from 'typeorm';
import { CreateModelAccountsAndPolicies1791160000000 } from '../1791160000000-CreateModelAccountsAndPolicies';

/**
 * Migration test for the provider-account and model-policy tables (AW-16).
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters:
 *
 *  - both tables carry every column their entity declares;
 *  - an account name is unique within its provider in one workspace, but the
 *    same name may exist on another provider or in another workspace;
 *  - one policy per scope per workspace;
 *  - a new account starts `unknown` and enabled, and every policy field
 *    starts NULL (= inherit);
 *  - a row's lifetime follows its workspace: deleting a member (even the
 *    creator) keeps an organization's rows, deleting a person removes their
 *    personal rows, deleting an organization removes its rows;
 *  - `up()` is idempotent and `down()` removes exactly what `up()` added.
 */
describe('CreateModelAccountsAndPolicies1791160000000', () => {
    let dataSource: DataSource;
    const migration = new CreateModelAccountsAndPolicies1791160000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
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
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(`CREATE TABLE "organizations" ("id" varchar PRIMARY KEY NOT NULL)`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const insertAccount = (id: string, workspaceKey: string, provider: string, label: string) =>
        dataSource.query(
            `INSERT INTO "model_accounts" ("id", "userId", "workspaceKey", "providerPluginId", "label", "position")
             VALUES (?, 'u1', ?, ?, ?, 1)`,
            [id, workspaceKey, provider, label],
        );

    it('creates model_accounts with every column the entity declares', async () => {
        await run('up');
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('model_accounts');
        await runner.release();
        expect(table?.columns.map((column) => column.name).sort()).toEqual(
            [
                'consecutiveFailures',
                'cooldownReason',
                'cooldownUntil',
                'createdAt',
                'credentialExpiresAt',
                'credentialVersion',
                'credentials',
                'enabled',
                'health',
                'id',
                'label',
                'lastCheckedAt',
                'lastUsedAt',
                'organizationId',
                'ownerUserId',
                'position',
                'providerPluginId',
                'tenantId',
                'updatedAt',
                'userId',
                'workspaceKey',
            ].sort(),
        );
        expect(table?.indices.map((index) => index.name).sort()).toEqual([
            'idx_model_accounts_checked',
            'idx_model_accounts_workspace_provider_position',
            'uq_model_accounts_workspace_provider_label',
        ]);
        expect(
            table?.foreignKeys.map((fk) => [fk.name, fk.referencedTableName, fk.onDelete]).sort(),
        ).toEqual([
            ['fk_model_accounts_organization', 'organizations', 'CASCADE'],
            ['fk_model_accounts_owner_user', 'users', 'CASCADE'],
            ['fk_model_accounts_user', 'users', 'SET NULL'],
        ]);
    });

    it('starts a new account unknown, enabled, at credential version 1 with no cooldown', async () => {
        await run('up');
        await insertAccount('a1', 'org:o1', 'provider-a', 'Company key');
        const [row] = await dataSource.query(
            `SELECT "health", "enabled", "credentialVersion", "consecutiveFailures", "cooldownUntil", "credentials" FROM "model_accounts"`,
        );
        expect(row.health).toBe('unknown');
        expect(Number(row.enabled)).toBe(1);
        expect(row.credentialVersion).toBe(1);
        expect(row.consecutiveFailures).toBe(0);
        expect(row.cooldownUntil).toBeNull();
        expect(row.credentials).toBeNull();
    });

    it('refuses a duplicate name on the same provider in the same workspace only', async () => {
        await run('up');
        await insertAccount('a1', 'org:o1', 'provider-a', 'Company key');
        await expect(insertAccount('a2', 'org:o1', 'provider-a', 'Company key')).rejects.toThrow(
            /UNIQUE/i,
        );
        await expect(
            insertAccount('a3', 'org:o1', 'provider-b', 'Company key'),
        ).resolves.toBeDefined();
        await expect(
            insertAccount('a4', 'user:u1', 'provider-a', 'Company key'),
        ).resolves.toBeDefined();
    });

    it('creates model_policies with one row per scope per workspace and NULL fields', async () => {
        await run('up');
        const insert = (id: string, workspaceKey: string, scopeKey: string) =>
            dataSource.query(
                `INSERT INTO "model_policies" ("id", "userId", "workspaceKey", "scopeKey", "scopeType")
                 VALUES (?, 'u1', ?, ?, 'workspace')`,
                [id, workspaceKey, scopeKey],
            );
        await insert('p1', 'org:o1', 'workspace');
        await expect(insert('p2', 'org:o1', 'workspace')).rejects.toThrow(/UNIQUE/i);
        await expect(insert('p3', 'user:u1', 'workspace')).resolves.toBeDefined();

        const [row] = await dataSource.query(
            `SELECT "primaryModel", "fallbackModels", "reasoningEffort", "runTimeoutSeconds", "attemptTimeoutSeconds", "scopeId", "scopeVariant"
             FROM "model_policies" WHERE "id" = 'p1'`,
        );
        expect(row).toEqual({
            primaryModel: null,
            fallbackModels: null,
            reasoningEffort: null,
            runTimeoutSeconds: null,
            attemptTimeoutSeconds: null,
            scopeId: null,
            scopeVariant: null,
        });
    });

    describe('row lifetime follows the workspace, not the writer', () => {
        const ORG = 'o1';
        const accountRows = () =>
            dataSource.query(
                `SELECT "id", "userId", "ownerUserId", "organizationId" FROM "model_accounts" ORDER BY "id"`,
            );
        const policyRows = () =>
            dataSource.query(
                `SELECT "id", "userId", "ownerUserId", "organizationId" FROM "model_policies" ORDER BY "id"`,
            );

        beforeEach(async () => {
            await run('up');
            await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u2')`);
            await dataSource.query(`INSERT INTO "organizations" ("id") VALUES (?)`, [ORG]);
            // u1 created the organization's account and last wrote its policy.
            await dataSource.query(
                `INSERT INTO "model_accounts" ("id", "userId", "ownerUserId", "organizationId", "workspaceKey", "providerPluginId", "label", "position")
                 VALUES ('org-acc', 'u1', NULL, ?, 'org:o1', 'provider-a', 'Shared key', 1),
                        ('u1-acc', 'u1', 'u1', NULL, 'user:u1', 'provider-a', 'My key', 1),
                        ('u2-acc', 'u2', 'u2', NULL, 'user:u2', 'provider-a', 'My key', 1)`,
                [ORG],
            );
            await dataSource.query(
                `INSERT INTO "model_policies" ("id", "userId", "ownerUserId", "organizationId", "workspaceKey", "scopeKey", "scopeType")
                 VALUES ('org-pol', 'u1', NULL, ?, 'org:o1', 'workspace', 'workspace'),
                        ('u1-pol', 'u1', 'u1', NULL, 'user:u1', 'workspace', 'workspace')`,
                [ORG],
            );
        });

        it("keeps an organization's accounts and policies when their creator is deleted, and removes that person's own", async () => {
            await dataSource.query(`DELETE FROM "users" WHERE "id" = 'u1'`);

            expect(await accountRows()).toEqual([
                { id: 'org-acc', userId: null, ownerUserId: null, organizationId: ORG },
                { id: 'u2-acc', userId: 'u2', ownerUserId: 'u2', organizationId: null },
            ]);
            expect(await policyRows()).toEqual([
                { id: 'org-pol', userId: null, ownerUserId: null, organizationId: ORG },
            ]);
        });

        it("removes an organization's accounts and policies with the organization", async () => {
            await dataSource.query(`DELETE FROM "organizations" WHERE "id" = ?`, [ORG]);

            expect((await accountRows()).map((row: { id: string }) => row.id)).toEqual([
                'u1-acc',
                'u2-acc',
            ]);
            expect((await policyRows()).map((row: { id: string }) => row.id)).toEqual(['u1-pol']);
        });
    });

    it('is idempotent', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
    });

    it('down() removes exactly what up() added', async () => {
        await run('up');
        await run('down');
        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('model_accounts')).toBe(false);
        expect(await runner.hasTable('model_policies')).toBe(false);
        expect(await runner.hasTable('users')).toBe(true);
        await runner.release();
    });
});
