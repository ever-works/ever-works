import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * One table that gains `visibility` / `visibilityExplicit`, and how a row of it
 * "sits on a Team" for the D11 backfill.
 */
interface VisibilityTable {
    table: string;
    /** `team_resources.resourceType` that points at this table. */
    resourceType: string;
    /** A direct team column on the row itself (tasks only). */
    teamColumn?: string;
    /** `team_members.memberType` that points at this table (agents only). */
    teamMemberType?: string;
}

/**
 * Record visibility (EW-P1-3, `docs/specs/features/record-visibility/spec.md`;
 * owner decisions D6 and D11 of the Ever Gauzy integration plan).
 *
 * Tasks, Goals, Missions, Ideas (`work_proposals`) and Agents stay owned by their
 * user exactly as before. Two columns ADD who else may read an org-scope row:
 *
 *   - `visibility varchar(16) NOT NULL DEFAULT 'private'` — `private` | `team` |
 *     `organization`;
 *   - `visibilityExplicit boolean NOT NULL DEFAULT false` — set once somebody picks a
 *     value by hand, which stops the automatic Team ↔ Organization changes.
 *
 * **Backfill (D11, applied to EXISTING rows automatically — no opt-in):** every
 * org-scope row (`organizationId IS NOT NULL`) becomes `team` when it sits on a Team
 * (`tasks.teamId`, a `team_resources` row of its type, or — for agents — a
 * `team_members` row) and `organization` otherwise. Personal-scope rows
 * (`organizationId IS NULL`) stay `private`. Only rows still at the column default
 * (`private`, not explicit) are touched, so a re-run, or a run after somebody chose
 * `private` by hand, changes nothing.
 *
 * **Roster backfill:** every active user whose `users.tenantId` matches an
 * Organization's Tenant and who holds no roster row in that Tenant yet (they joined
 * before `organization_members` existed; it is empty in production) gets a row in
 * every Organization of the Tenant. Access in Ever Works is tenant-wide
 * (`OrganizationMembershipService` compares `user.tenantId` with
 * `organization.tenantId`), so they can already open those Organizations; the roster
 * only records it. Users who already hold a row joined through the invitation flow,
 * which records the Organization they were invited to, and are left alone. The Tenant
 * owner is skipped: a member by construction (`listMembers` synthesizes the row, seat
 * counting already counts them).
 *
 * Also: `idx_<table>_org_visibility (organizationId, visibility)` per table for the
 * org-wide reads of the access policy.
 *
 * `team_resources.resourceType` gains `goal` in code only: the column is a plain
 * `varchar(16)` with no CHECK constraint.
 *
 * Portable on Postgres, MySQL and better-sqlite3: `TableColumn` / `TableIndex` DDL,
 * identifiers quoted by the driver, and the dialect's boolean literal.
 *
 * `down()` drops the indexes and both columns. It leaves the backfilled roster rows:
 * they state true tenant membership, and they cannot be told apart from rows an
 * invitation acceptance wrote after this migration ran.
 */
export class AddRecordVisibility1795070000000 implements MigrationInterface {
    name = 'AddRecordVisibility1795070000000';

    static readonly TABLES: readonly VisibilityTable[] = [
        { table: 'tasks', resourceType: 'task', teamColumn: 'teamId' },
        { table: 'goals', resourceType: 'goal' },
        { table: 'missions', resourceType: 'mission' },
        { table: 'work_proposals', resourceType: 'idea' },
        { table: 'agents', resourceType: 'agent', teamMemberType: 'agent' },
    ];

    static readonly ROSTER_BATCH = 500;

    static indexName(table: string): string {
        return `idx_${table}_org_visibility`;
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const spec of AddRecordVisibility1795070000000.TABLES) {
            await this.addColumns(queryRunner, spec.table);
        }
        for (const spec of AddRecordVisibility1795070000000.TABLES) {
            await this.backfillVisibility(queryRunner, spec);
        }
        await this.backfillRoster(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const spec of [...AddRecordVisibility1795070000000.TABLES].reverse()) {
            const table = await queryRunner.getTable(spec.table);
            if (!table) continue;
            const indexName = AddRecordVisibility1795070000000.indexName(spec.table);
            if (table.indices.some((index) => index.name === indexName)) {
                await queryRunner.dropIndex(spec.table, indexName);
            }
            for (const column of ['visibilityExplicit', 'visibility']) {
                // Re-read each time: the sqlite driver rebuilds the table on
                // every column drop, so earlier metadata is stale.
                const current = await queryRunner.getTable(spec.table);
                if (current?.findColumnByName(column)) {
                    await queryRunner.dropColumn(spec.table, column);
                }
            }
        }
    }

    private async addColumns(queryRunner: QueryRunner, tableName: string): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        if (!table) return;

        if (!table.findColumnByName('visibility')) {
            await queryRunner.addColumn(
                tableName,
                new TableColumn({
                    name: 'visibility',
                    type: 'varchar',
                    length: '16',
                    isNullable: false,
                    default: "'private'",
                }),
            );
        }

        const afterVisibility = await queryRunner.getTable(tableName);
        if (afterVisibility && !afterVisibility.findColumnByName('visibilityExplicit')) {
            await queryRunner.addColumn(
                tableName,
                new TableColumn({
                    name: 'visibilityExplicit',
                    type: 'boolean',
                    isNullable: false,
                    default: false,
                }),
            );
        }

        const indexName = AddRecordVisibility1795070000000.indexName(tableName);
        const refreshed = await queryRunner.getTable(tableName);
        if (refreshed && !refreshed.indices.some((index) => index.name === indexName)) {
            await queryRunner.createIndex(
                tableName,
                new TableIndex({ name: indexName, columnNames: ['organizationId', 'visibility'] }),
            );
        }
    }

    /**
     * D11 for existing rows: org rows on a Team → `team`, the remaining org rows →
     * `organization`. Only rows still at the default (`private`, not explicit) move.
     */
    private async backfillVisibility(
        queryRunner: QueryRunner,
        spec: VisibilityTable,
    ): Promise<void> {
        const table = await queryRunner.getTable(spec.table);
        if (!table?.findColumnByName('visibility')) return;

        const q = (identifier: string): string => queryRunner.connection.driver.escape(identifier);
        const t = q(spec.table);
        const falseLiteral = this.booleanLiteral(queryRunner, false);
        const stillDefault =
            `${t}.${q('organizationId')} IS NOT NULL` +
            ` AND ${t}.${q('visibility')} = 'private'` +
            ` AND ${t}.${q('visibilityExplicit')} = ${falseLiteral}`;

        const onTeam: string[] = [];
        if (spec.teamColumn && table.findColumnByName(spec.teamColumn)) {
            onTeam.push(`${t}.${q(spec.teamColumn)} IS NOT NULL`);
        }
        if (await queryRunner.hasTable('team_resources')) {
            onTeam.push(
                `EXISTS (SELECT 1 FROM ${q('team_resources')} tr` +
                    ` WHERE tr.${q('resourceType')} = '${spec.resourceType}'` +
                    ` AND tr.${q('resourceId')} = ${t}.${q('id')})`,
            );
        }
        if (spec.teamMemberType && (await queryRunner.hasTable('team_members'))) {
            onTeam.push(
                `EXISTS (SELECT 1 FROM ${q('team_members')} tm` +
                    ` WHERE tm.${q('memberType')} = '${spec.teamMemberType}'` +
                    ` AND tm.${q('memberId')} = ${t}.${q('id')})`,
            );
        }

        if (onTeam.length > 0) {
            await queryRunner.query(
                `UPDATE ${t} SET ${q('visibility')} = 'team'` +
                    ` WHERE ${stillDefault} AND (${onTeam.join(' OR ')})`,
            );
        }
        await queryRunner.query(
            `UPDATE ${t} SET ${q('visibility')} = 'organization' WHERE ${stillDefault}`,
        );
    }

    /**
     * Roster rows for the members who joined before the roster existed.
     *
     * A person with NO roster row anywhere in their Tenant joined before
     * `organization_members` was written (it is empty in production), so nothing says
     * which Organization they were invited to: they get a row in every Organization of
     * their Tenant, which is exactly the access they have. A person who already holds a
     * row joined through the roster-era invitation flow, which records the Organization
     * they were invited to; they are left as they are, so `removeMember` keeps revoking
     * what it revokes today.
     *
     * Keyset batches over users; a user's rows are inserted together, and a re-run
     * finds no candidates, which is what makes the backfill idempotent.
     */
    private async backfillRoster(queryRunner: QueryRunner): Promise<void> {
        for (const required of ['organization_members', 'organizations', 'users']) {
            if (!(await queryRunner.hasTable(required))) return;
        }
        const users = await queryRunner.getTable('users');
        const hasTenants = await queryRunner.hasTable('tenants');
        const q = (identifier: string): string => queryRunner.connection.driver.escape(identifier);
        const trueLiteral = this.booleanLiteral(queryRunner, true);
        const falseLiteral = this.booleanLiteral(queryRunner, false);
        const batch = AddRecordVisibility1795070000000.ROSTER_BATCH;
        let afterUserId: string | null = null;

        for (;;) {
            const qb = queryRunner.manager
                .createQueryBuilder()
                .select(`u.${q('id')}`, 'userId')
                .addSelect(`u.${q('tenantId')}`, 'tenantId')
                .from('users', 'u')
                .where(`u.${q('tenantId')} IS NOT NULL`)
                .andWhere(`u.${q('isActive')} = ${trueLiteral}`)
                .andWhere(
                    `NOT EXISTS (SELECT 1 FROM ${q('organization_members')} m` +
                        ` WHERE m.${q('userId')} = u.${q('id')}` +
                        ` AND m.${q('tenantId')} = u.${q('tenantId')})`,
                );
            if (users?.findColumnByName('isAnonymous')) {
                qb.andWhere(`u.${q('isAnonymous')} = ${falseLiteral}`);
            }
            if (hasTenants) {
                qb.andWhere(
                    `NOT EXISTS (SELECT 1 FROM ${q('tenants')} tn` +
                        ` WHERE tn.${q('id')} = u.${q('tenantId')}` +
                        ` AND tn.${q('ownerUserId')} = u.${q('id')})`,
                );
            }
            if (afterUserId !== null) {
                qb.andWhere(`u.${q('id')} > :afterUserId`, { afterUserId });
            }
            const candidates = await qb
                .orderBy(`u.${q('id')}`, 'ASC')
                .limit(batch)
                .getRawMany<{ userId: string; tenantId: string }>();
            if (candidates.length === 0) return;
            afterUserId = candidates[candidates.length - 1].userId;

            const tenantIds = [...new Set(candidates.map((candidate) => candidate.tenantId))];
            const organizations = await queryRunner.manager
                .createQueryBuilder()
                .select(`o.${q('id')}`, 'organizationId')
                .addSelect(`o.${q('tenantId')}`, 'tenantId')
                .from('organizations', 'o')
                .where(`o.${q('tenantId')} IN (:...tenantIds)`, { tenantIds })
                .getRawMany<{ organizationId: string; tenantId: string }>();

            const now = new Date();
            const members = candidates.flatMap((candidate) =>
                organizations
                    .filter((organization) => organization.tenantId === candidate.tenantId)
                    .map((organization) => ({
                        id: randomUUID(),
                        organizationId: organization.organizationId,
                        tenantId: organization.tenantId,
                        userId: candidate.userId,
                        role: 'member',
                        invitedById: null,
                        invitationId: null,
                        joinedAt: now,
                        createdAt: now,
                        updatedAt: now,
                    })),
            );

            for (let offset = 0; offset < members.length; offset += batch) {
                const chunk = members.slice(offset, offset + batch);
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into('organization_members', [
                        'id',
                        'organizationId',
                        'tenantId',
                        'userId',
                        'role',
                        'invitedById',
                        'invitationId',
                        'joinedAt',
                        'createdAt',
                        'updatedAt',
                    ])
                    .values(chunk)
                    .execute();

                // Nobody recorded when a pre-roster member joined; the earliest
                // moment they can have been one is when both the Organization and
                // their account existed. Copied inside the database, so no driver
                // turns a zone-less timestamp into a shifted JS Date on the way.
                await queryRunner.manager
                    .createQueryBuilder()
                    .update('organization_members')
                    .set({
                        joinedAt: () =>
                            `(SELECT CASE WHEN o2.${q('createdAt')} > u2.${q('createdAt')}` +
                            ` THEN o2.${q('createdAt')} ELSE u2.${q('createdAt')} END` +
                            ` FROM ${q('organizations')} o2, ${q('users')} u2` +
                            ` WHERE o2.${q('id')} = ${q('organization_members')}.${q('organizationId')}` +
                            ` AND u2.${q('id')} = ${q('organization_members')}.${q('userId')})`,
                    })
                    .where(`${q('id')} IN (:...ids)`, { ids: chunk.map((member) => member.id) })
                    .execute();
            }

            if (candidates.length < batch) return;
        }
    }

    /** `true`/`false` on Postgres; `1`/`0` on MySQL (tinyint) and SQLite (integer). */
    private booleanLiteral(queryRunner: QueryRunner, value: boolean): string {
        const type = queryRunner.connection.driver.options.type;
        if (type === 'postgres' || type === 'cockroachdb') {
            return value ? 'true' : 'false';
        }
        return value ? '1' : '0';
    }
}
