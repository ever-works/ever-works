import { DataSource } from 'typeorm';
import { AddRecordVisibility1795070000000 } from '../1795070000000-AddRecordVisibility';

/**
 * Migration test for record visibility (EW-P1-3, owner decision D11).
 *
 * In-memory better-sqlite3, asserting the PHYSICAL schema through `PRAGMA` and the
 * backfill through plain SELECTs, like the other migration specs. Only the columns the
 * migration reads or writes are created.
 */
describe('AddRecordVisibility1795070000000', () => {
    let dataSource: DataSource;
    const migration = new AddRecordVisibility1795070000000();
    const TABLES = ['tasks', 'goals', 'missions', 'work_proposals', 'agents'];

    const columns = async (
        table: string,
    ): Promise<Array<{ name: string; notnull: number; dflt_value: string | null }>> =>
        dataSource.query(`PRAGMA table_info("${table}")`);
    const indexNames = async (table: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_list("${table}")`)) as Array<{ name: string }>).map(
            (index) => index.name,
        );
    const visibilityOf = async (table: string): Promise<Record<string, string>> => {
        const rows = (await dataSource.query(
            `SELECT "id", "visibility" FROM "${table}" ORDER BY "id"`,
        )) as Array<{ id: string; visibility: string }>;
        return Object.fromEntries(rows.map((row) => [row.id, row.visibility]));
    };
    const roster = async (): Promise<string[]> =>
        (
            (await dataSource.query(
                `SELECT "organizationId", "userId" FROM "organization_members" ORDER BY "organizationId", "userId"`,
            )) as Array<{ organizationId: string; userId: string }>
        ).map((row) => `${row.organizationId}:${row.userId}`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        await dataSource.query(
            `CREATE TABLE "tenants" ("id" varchar PRIMARY KEY NOT NULL, "ownerUserId" varchar NOT NULL)`,
        );
        await dataSource.query(
            `CREATE TABLE "organizations" ("id" varchar PRIMARY KEY NOT NULL, "tenantId" varchar NOT NULL, "createdAt" datetime NOT NULL)`,
        );
        await dataSource.query(
            `CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "tenantId" varchar, "isActive" boolean NOT NULL DEFAULT (1), "isAnonymous" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL)`,
        );
        await dataSource.query(
            `CREATE TABLE "organization_members" ("id" varchar PRIMARY KEY NOT NULL, "organizationId" varchar NOT NULL, "tenantId" varchar NOT NULL, "userId" varchar NOT NULL, "role" varchar(32) NOT NULL DEFAULT ('member'), "invitedById" varchar, "invitationId" varchar, "joinedAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "uq_org_members_org_user" UNIQUE ("organizationId", "userId"))`,
        );
        await dataSource.query(
            `CREATE TABLE "team_resources" ("id" varchar PRIMARY KEY NOT NULL, "teamId" varchar NOT NULL, "resourceType" varchar(16) NOT NULL, "resourceId" varchar NOT NULL)`,
        );
        await dataSource.query(
            `CREATE TABLE "team_members" ("id" varchar PRIMARY KEY NOT NULL, "teamId" varchar NOT NULL, "memberType" varchar(8) NOT NULL, "memberId" varchar NOT NULL)`,
        );
        await dataSource.query(
            `CREATE TABLE "tasks" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "teamId" varchar, "tenantId" varchar, "organizationId" varchar)`,
        );
        for (const table of ['goals', 'missions', 'work_proposals', 'agents']) {
            await dataSource.query(
                `CREATE TABLE "${table}" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "tenantId" varchar, "organizationId" varchar)`,
            );
        }

        // Tenant T (owner u-owner) with orgs A and B; tenant X with org C.
        await dataSource.query(`INSERT INTO "tenants" VALUES ('T', 'u-owner'), ('X', 'u-x')`);
        await dataSource.query(
            `INSERT INTO "organizations" VALUES ('org-a', 'T', '2026-01-01 00:00:00'), ('org-b', 'T', '2026-03-01 00:00:00'), ('org-c', 'X', '2026-01-01 00:00:00')`,
        );
        await dataSource.query(
            `INSERT INTO "users" ("id", "tenantId", "isActive", "isAnonymous", "createdAt") VALUES
                ('u-owner', 'T', 1, 0, '2025-01-01 00:00:00'),
                ('u-member', 'T', 1, 0, '2026-02-01 00:00:00'),
                ('u-invited', 'T', 1, 0, '2025-06-01 00:00:00'),
                ('u-inactive', 'T', 0, 0, '2025-06-01 00:00:00'),
                ('u-anon', 'T', 1, 1, '2025-06-01 00:00:00'),
                ('u-solo', NULL, 1, 0, '2025-06-01 00:00:00'),
                ('u-x', 'X', 1, 0, '2025-06-01 00:00:00')`,
        );
        // u-invited already holds a roster row for org-a (an earlier invite accept).
        await dataSource.query(
            `INSERT INTO "organization_members" ("id", "organizationId", "tenantId", "userId", "joinedAt") VALUES ('m-1', 'org-a', 'T', 'u-invited', '2026-04-01 00:00:00')`,
        );

        // Tasks: personal, org with teamId, org with a team_resources row, org with no team.
        await dataSource.query(
            `INSERT INTO "tasks" VALUES
                ('t-personal', 'u-owner', 'team-1', 'T', NULL),
                ('t-team-col', 'u-owner', 'team-1', 'T', 'org-a'),
                ('t-team-res', 'u-owner', NULL, 'T', 'org-a'),
                ('t-org', 'u-owner', NULL, 'T', 'org-a')`,
        );
        for (const [table, prefix] of [
            ['goals', 'g'],
            ['missions', 'm'],
            ['work_proposals', 'i'],
            ['agents', 'a'],
        ]) {
            await dataSource.query(
                `INSERT INTO "${table}" VALUES
                    ('${prefix}-personal', 'u-owner', 'T', NULL),
                    ('${prefix}-team', 'u-owner', 'T', 'org-a'),
                    ('${prefix}-org', 'u-owner', 'T', 'org-a')`,
            );
        }
        // Agents also reach a Team through team_members.
        await dataSource.query(`INSERT INTO "agents" VALUES ('a-member', 'u-owner', 'T', 'org-b')`);
        await dataSource.query(
            `INSERT INTO "team_resources" VALUES
                ('r-1', 'team-1', 'task', 't-team-res'),
                ('r-2', 'team-1', 'goal', 'g-team'),
                ('r-3', 'team-1', 'mission', 'm-team'),
                ('r-4', 'team-1', 'idea', 'i-team'),
                ('r-5', 'team-1', 'agent', 'a-team'),
                ('r-6', 'team-1', 'mission', 'g-org')`,
        );
        await dataSource.query(
            `INSERT INTO "team_members" VALUES ('tm-1', 'team-2', 'agent', 'a-member')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds visibility (NOT NULL default private) + visibilityExplicit (NOT NULL default false) and the index on all five tables', async () => {
        await migration.up(dataSource.createQueryRunner());
        for (const table of TABLES) {
            const physical = await columns(table);
            const visibility = physical.find((column) => column.name === 'visibility');
            const explicit = physical.find((column) => column.name === 'visibilityExplicit');
            expect(visibility).toEqual(expect.objectContaining({ notnull: 1 }));
            expect(visibility?.dflt_value).toBe(`'private'`);
            expect(explicit).toEqual(expect.objectContaining({ notnull: 1 }));
            expect(['0', 'false', 'FALSE']).toContain(String(explicit?.dflt_value));
            expect(await indexNames(table)).toContain(`idx_${table}_org_visibility`);
        }
    });

    it('backfills D11: org rows on a Team → team, other org rows → organization, personal rows stay private', async () => {
        await migration.up(dataSource.createQueryRunner());

        expect(await visibilityOf('tasks')).toEqual({
            't-org': 'organization',
            't-personal': 'private',
            't-team-col': 'team',
            't-team-res': 'team',
        });
        expect(await visibilityOf('goals')).toEqual({
            'g-org': 'organization', // r-6 is a `mission` row with g-org's id: the type must match
            'g-personal': 'private',
            'g-team': 'team',
        });
        expect(await visibilityOf('missions')).toEqual({
            'm-org': 'organization',
            'm-personal': 'private',
            'm-team': 'team',
        });
        expect(await visibilityOf('work_proposals')).toEqual({
            'i-org': 'organization',
            'i-personal': 'private',
            'i-team': 'team',
        });
        expect(await visibilityOf('agents')).toEqual({
            'a-member': 'team',
            'a-org': 'organization',
            'a-personal': 'private',
            'a-team': 'team',
        });
        const explicit = (await dataSource.query(
            `SELECT COUNT(*) AS n FROM "tasks" WHERE "visibilityExplicit" <> 0`,
        )) as Array<{ n: number }>;
        expect(Number(explicit[0].n)).toBe(0);
    });

    it('never touches a row somebody set by hand, and a re-run changes nothing', async () => {
        await migration.up(dataSource.createQueryRunner());
        await dataSource.query(
            `UPDATE "tasks" SET "visibility" = 'private', "visibilityExplicit" = 1 WHERE "id" = 't-org'`,
        );
        await dataSource.query(
            `UPDATE "goals" SET "visibility" = 'organization', "visibilityExplicit" = 1 WHERE "id" = 'g-team'`,
        );
        const rosterBefore = await roster();

        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();

        expect((await visibilityOf('tasks'))['t-org']).toBe('private');
        expect((await visibilityOf('goals'))['g-team']).toBe('organization');
        expect(await roster()).toEqual(rosterBefore);
        for (const table of TABLES) {
            expect(
                (await columns(table)).filter((column) => column.name === 'visibility'),
            ).toHaveLength(1);
        }
    });

    it('backfills the roster for pre-roster members only: every org of their tenant; owner, inactive, anonymous and invited skipped', async () => {
        await migration.up(dataSource.createQueryRunner());
        // Skipped: u-owner and u-x (Tenant owners, members by construction), u-inactive,
        // u-anon and u-solo (no tenant), and u-invited, whose roster-era invitation
        // already records the one Organization they joined. u-member predates the
        // roster, so they get every Organization of their Tenant.
        expect(await roster()).toEqual(['org-a:u-invited', 'org-a:u-member', 'org-b:u-member']);

        const rows = (await dataSource.query(
            `SELECT "tenantId", "role", "invitedById", "invitationId", "joinedAt" FROM "organization_members" WHERE "organizationId" = 'org-b' AND "userId" = 'u-member'`,
        )) as Array<{
            tenantId: string;
            role: string;
            invitedById: string | null;
            invitationId: string | null;
            joinedAt: string;
        }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(
            expect.objectContaining({
                tenantId: 'T',
                role: 'member',
                invitedById: null,
                invitationId: null,
            }),
        );
        // The later of the org's creation (2026-03-01) and the account's (2026-02-01).
        expect(String(rows[0].joinedAt)).toContain('2026-03-01');
    });

    it('down() removes both columns and the index, and keeps every row', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.down(dataSource.createQueryRunner());
        for (const table of TABLES) {
            const names = (await columns(table)).map((column) => column.name);
            expect(names).not.toContain('visibility');
            expect(names).not.toContain('visibilityExplicit');
            expect(await indexNames(table)).not.toContain(`idx_${table}_org_visibility`);
        }
        const tasks = (await dataSource.query(`SELECT COUNT(*) AS n FROM "tasks"`)) as Array<{
            n: number;
        }>;
        expect(Number(tasks[0].n)).toBe(4);
        // Roster rows state true tenant membership and are kept (see the migration docblock).
        expect((await roster()).length).toBe(3);
        // A second down() is a no-op.
        await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();
    });
});
