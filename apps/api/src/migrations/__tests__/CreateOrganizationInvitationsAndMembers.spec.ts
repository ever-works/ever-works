import { DataSource, Table } from 'typeorm';
import { CreateOrganizationInvitationsAndMembers1786930000000 } from '../1786930000000-CreateOrganizationInvitationsAndMembers';

/**
 * Executes the organization-invitations migration against a real (in-memory)
 * database rather than only compiling it.
 *
 * This migration carries more risk than most, for a reason worth stating:
 * **`DATABASE_AUTOMIGRATE` (TypeORM `synchronize`) is true in dev and stage
 * but false in production** — verified on the live Secrets of
 * `ever-works-app-{dev,stage,prod}`. In dev and stage, `synchronize` creates
 * these tables from the entities whether or not this file works, so a broken
 * migration is completely invisible there and first appears as a crash-looping
 * prod pod. A green dev rollout is not evidence. This spec is.
 *
 * better-sqlite3 is what CI and the e2e stack run, so a Postgres-only
 * construct here fails the build — which is the point (`now()` and
 * `uuid_generate_v4()` are both guarded in the migration for exactly that
 * reason).
 *
 * Lives in `__tests__/` for the reason spelled out in
 * `AddCostsDashboardIndexes.spec.ts`: the runtime migration glob is the FLAT
 * `dist/migrations/*.js`, and a spec compiled into it is loaded as a
 * migration, whose top-level `describe(...)` crash-loops every API pod.
 * Pinned by `migrations-directory-contract.spec.ts`.
 */
describe('CreateOrganizationInvitationsAndMembers1786930000000', () => {
    let dataSource: DataSource;

    /** The FK targets. Minimal stubs — this spec is about the new tables. */
    async function createReferencedTables(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        for (const name of ['users', 'tenants', 'organizations']) {
            await runner.createTable(
                new Table({
                    name,
                    columns: [{ name: 'id', type: 'uuid', isPrimary: true }],
                }),
                true,
            );
        }
        await runner.release();
    }

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await new CreateOrganizationInvitationsAndMembers1786930000000().up(runner);
        await runner.release();
    }

    it('creates both tables with every index the entities declare', async () => {
        await createReferencedTables();
        await runUp();

        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('organization_invitations')).toBe(true);
        expect(await runner.hasTable('organization_members')).toBe(true);

        const invitations = await runner.getTable('organization_invitations');
        const members = await runner.getTable('organization_members');
        await runner.release();

        const indexNames = (t: Table | undefined) => (t?.indices ?? []).map((i) => i.name).sort();
        expect(indexNames(invitations)).toEqual(
            [
                'idx_org_invitations_org',
                'idx_org_invitations_status',
                'uq_org_invitations_pending_email',
                'uq_org_invitations_token_hash',
            ].sort(),
        );
        expect(indexNames(members)).toEqual(
            ['idx_org_members_org', 'idx_org_members_user', 'uq_org_members_org_user'].sort(),
        );
    });

    it('is idempotent — a second run over an applied schema is a no-op', async () => {
        // The state a partially-applied or re-run deployment is actually in.
        // Without the hasTable guards this throws, and with migrationsRun the
        // throw crash-loops every API pod on boot.
        await createReferencedTables();
        await runUp();
        await expect(runUp()).resolves.not.toThrow();

        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('organization_invitations')).toBe(true);
        await runner.release();
    });

    it('down() drops both tables, child first', async () => {
        await createReferencedTables();
        await runUp();

        const runner = dataSource.createQueryRunner();
        await new CreateOrganizationInvitationsAndMembers1786930000000().down(runner);

        expect(await runner.hasTable('organization_members')).toBe(false);
        expect(await runner.hasTable('organization_invitations')).toBe(false);
        // The FK targets are untouched — down() must never reach past its own
        // tables.
        expect(await runner.hasTable('users')).toBe(true);
        expect(await runner.hasTable('organizations')).toBe(true);
        await runner.release();
    });

    it('the pending-email index permits a re-invite after a revoke', async () => {
        // The behaviour the partial WHERE buys. A plain unique index would let
        // a single revoked invitation block that address forever.
        await createReferencedTables();
        await runUp();

        const runner = dataSource.createQueryRunner();
        await runner.query(`INSERT INTO organizations (id) VALUES ('org-1')`);
        await runner.query(`INSERT INTO tenants (id) VALUES ('ten-1')`);
        await runner.query(`INSERT INTO users (id) VALUES ('u-1')`);

        const insert = (id: string, status: string) =>
            runner.query(
                `INSERT INTO organization_invitations
                   (id, "organizationId", "tenantId", email, "emailNormalized", role,
                    "tokenHash", "tokenExpiresAt", "invitedById", status)
                 VALUES ('${id}', 'org-1', 'ten-1', 'A@x.com', 'a@x.com', 'member',
                    'hash-${id}', '2030-01-01 00:00:00', 'u-1', '${status}')`,
            );

        await insert('i1', 'pending');
        // Second PENDING invite for the same mailbox — rejected.
        await expect(insert('i2', 'pending')).rejects.toThrow();
        // Revoke the first, and the address is invitable again.
        await runner.query(`UPDATE organization_invitations SET status='revoked' WHERE id='i1'`);
        await expect(insert('i3', 'pending')).resolves.not.toThrow();

        await runner.release();
    });
});
