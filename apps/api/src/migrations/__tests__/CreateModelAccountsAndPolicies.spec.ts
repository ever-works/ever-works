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
        expect(table?.foreignKeys.map((fk) => fk.name)).toEqual(['fk_model_accounts_user']);
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
