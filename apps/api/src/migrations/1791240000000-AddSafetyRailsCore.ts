import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableForeignKey,
    TableIndex,
    type TableColumnOptions,
} from 'typeorm';

/**
 * Safety rails and the trust ladder (AW-24, phase P1) — three tables.
 *
 * Entities:
 *   - `packages/agent/src/entities/autonomy-grant.entity.ts`  → `autonomy_grants`
 *   - `packages/agent/src/entities/rail-refusal.entity.ts`    → `rail_refusals`
 *   - `packages/agent/src/entities/workspace-pause.entity.ts` → `workspace_pauses`
 *
 * ## Why three tables and not a column on something that exists
 *
 * - **`autonomy_grants`** — nothing existing models per-category autonomy.
 *   Tool grants match tool-name globs and carry no notion of a kind of work;
 *   the per-Agent dispatch guardrails are a two-mode JSON blob over four
 *   internal action types; merge policy is git-shaped. A fourteenth field on
 *   any of them would make one of them mean two things. All three keep
 *   working unchanged — where an Agent carries guardrails AND a rung, the
 *   stricter wins.
 * - **`rail_refusals`** — a refusal is currently an exception, a log line and
 *   sometimes a rejected approval row. There is no queryable record of what
 *   the rails stopped, which is the evidence behind every claim the Safety
 *   screen makes. Deliberately not an Activity row: a misconfigured agent can
 *   trip one rail hundreds of times an hour and the Live Feed must not drown.
 * - **`workspace_pauses`** — `fleet_kill_switch` is one global row owned by
 *   the platform operator; Agent / Mission / Run pauses are statuses on their
 *   own records. Nothing means "this workspace is stopped", and there is
 *   nowhere to hang the actor, the reason and the resume progress.
 *
 * ## The partial unique on `workspace_pauses`
 *
 * A workspace is `(tenantId, organizationId)` with a NULL organization for
 * the bare-tenant case, and SQL treats NULLs as DISTINCT inside a unique
 * index — so one plain unique pair would let a bare-tenant workspace be
 * paused twice. It is therefore TWO partial uniques, written by hand here
 * rather than declared on the entity: a decorator-level unique index would
 * additionally make TypeORM generate a non-partial duplicate on the
 * better-sqlite3 driver CI and the e2e stack run on.
 *
 * ## Foreign keys
 *
 * `userId` cascades on every table — these rows are a person's own workspace
 * configuration and audit trail, exactly as `tool_grants` is.
 *
 * `setByUserId` and `pausedByUserId` deliberately carry **no** foreign key.
 * Both are audit stamps on safety state, and both available cascade actions
 * are worse than a dangling id: `CASCADE` would delete a narrowed rung (a
 * silent WIDENING) or lift a pause (a silent RESUME) because some other
 * account was removed, and `SET NULL` cannot apply to a column FR-31 and
 * FR-47 require to be present. The stamp is read for display and for the
 * activity record, never as a join that must resolve.
 *
 * Forward-only, idempotent (`hasTable` / index-name / FK-name guards), and
 * portable `Table` DDL because production runs Postgres while CI runs
 * better-sqlite3. `down()` drops only the tables this migration created —
 * proven by a provenance index stamped on the create path, the same posture
 * `1791180000000-CreateSharedViews` documents.
 */
export class AddSafetyRailsCore1791240000000 implements MigrationInterface {
    name = 'AddSafetyRailsCore1791240000000';

    /** Marks a table this migration created, so `down()` never drops an adopted one. */
    private static ownershipMarker(table: string): TableIndex {
        return new TableIndex({ name: `idx_${table}_owned_1791240000000`, columnNames: ['id'] });
    }

    private static idColumn(isPostgres: boolean): TableColumnOptions {
        return {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: isPostgres ? 'uuid_generate_v4()' : undefined,
        };
    }

    private static autonomyGrantColumns(isPostgres: boolean): TableColumnOptions[] {
        return [
            AddSafetyRailsCore1791240000000.idColumn(isPostgres),
            { name: 'userId', type: 'uuid' },
            { name: 'scopeType', type: 'varchar', length: '16' },
            { name: 'scopeId', type: 'uuid' },
            { name: 'category', type: 'varchar', length: '24' },
            { name: 'rung', type: 'varchar', length: '8' },
            { name: 'setByUserId', type: 'uuid' },
            { name: 'note', type: 'varchar', length: '500', isNullable: true },
            { name: 'tenantId', type: 'uuid', isNullable: true },
            { name: 'organizationId', type: 'uuid', isNullable: true },
            { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
            { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ];
    }

    private static railRefusalColumns(isPostgres: boolean): TableColumnOptions[] {
        return [
            AddSafetyRailsCore1791240000000.idColumn(isPostgres),
            { name: 'userId', type: 'uuid' },
            { name: 'railId', type: 'varchar', length: '24' },
            { name: 'category', type: 'varchar', length: '24', isNullable: true },
            { name: 'verdict', type: 'varchar', length: '12' },
            { name: 'reasonCode', type: 'varchar', length: '32' },
            { name: 'subjectType', type: 'varchar', length: '16' },
            { name: 'subjectId', type: 'uuid', isNullable: true },
            { name: 'agentId', type: 'uuid', isNullable: true },
            { name: 'runId', type: 'uuid', isNullable: true },
            { name: 'summary', type: 'varchar', length: '500' },
            // `simple-json` on the entity — TEXT at the database layer, so the
            // same rows read identically on Postgres and better-sqlite3.
            { name: 'requested', type: 'text', isNullable: true },
            { name: 'ceiling', type: 'text', isNullable: true },
            { name: 'proposalId', type: 'uuid', isNullable: true },
            { name: 'collapseKey', type: 'varchar', length: '128' },
            { name: 'tenantId', type: 'uuid', isNullable: true },
            { name: 'organizationId', type: 'uuid', isNullable: true },
            { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ];
    }

    private static workspacePauseColumns(isPostgres: boolean): TableColumnOptions[] {
        return [
            AddSafetyRailsCore1791240000000.idColumn(isPostgres),
            { name: 'userId', type: 'uuid' },
            { name: 'tenantId', type: 'uuid' },
            { name: 'organizationId', type: 'uuid', isNullable: true },
            { name: 'reason', type: 'varchar', length: '500', isNullable: true },
            { name: 'pausedByUserId', type: 'uuid' },
            { name: 'pausedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
            { name: 'refusedStarts', type: 'int', default: 0 },
            { name: 'cleanlyStopped', type: 'int', default: 0 },
            { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
            { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ];
    }

    private static readonly AUTONOMY_GRANT_INDEXES = [
        new TableIndex({
            name: 'uq_autonomy_grants_owner_scope_category',
            columnNames: ['userId', 'scopeType', 'scopeId', 'category'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'idx_autonomy_grants_scope',
            columnNames: ['scopeType', 'scopeId'],
        }),
        new TableIndex({ name: 'idx_autonomy_grants_user', columnNames: ['userId'] }),
    ];

    private static readonly RAIL_REFUSAL_INDEXES = [
        new TableIndex({
            name: 'idx_rail_refusals_user_created',
            columnNames: ['userId', 'createdAt'],
        }),
        new TableIndex({ name: 'idx_rail_refusals_collapse', columnNames: ['collapseKey'] }),
        new TableIndex({
            name: 'idx_rail_refusals_agent_category',
            columnNames: ['agentId', 'category', 'createdAt'],
        }),
        new TableIndex({ name: 'idx_rail_refusals_rail', columnNames: ['railId', 'createdAt'] }),
    ];

    private static readonly WORKSPACE_PAUSE_INDEXES = [
        new TableIndex({ name: 'idx_workspace_pauses_tenant', columnNames: ['tenantId'] }),
        new TableIndex({ name: 'idx_workspace_pauses_user', columnNames: ['userId'] }),
    ];

    private static ownerForeignKey(table: string): TableForeignKey {
        return new TableForeignKey({
            name: `fk_${table}_user`,
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        });
    }

    /**
     * Create one table if it is absent, then reconcile its indexes and its
     * owner foreign key. A pre-existing table that does not carry every
     * declared column is somebody else's and is refused loudly rather than
     * having this feature's constraints bolted onto it.
     */
    private async ensureTable(
        queryRunner: QueryRunner,
        name: string,
        columns: TableColumnOptions[],
        indexes: TableIndex[],
    ): Promise<void> {
        const exists = await queryRunner.hasTable(name);
        if (exists) {
            const current = await queryRunner.getTable(name);
            const present = new Set((current?.columns ?? []).map((column) => column.name));
            const missing = columns.filter((column) => !present.has(column.name));
            if (missing.length > 0) {
                throw new Error(
                    `AddSafetyRailsCore1791240000000: a table named "${name}" already exists without the ` +
                        `columns this migration declares (${missing
                            .map((column) => column.name)
                            .join(
                                ', ',
                            )}). Refusing to adopt it — rename or drop that table, then run ` +
                        `the migration again.`,
                );
            }
        } else {
            await queryRunner.createTable(new Table({ name, columns }), true);
            await queryRunner.createIndex(
                name,
                AddSafetyRailsCore1791240000000.ownershipMarker(name),
            );
        }

        for (const index of indexes) {
            const table = await queryRunner.getTable(name);
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(name, index);
            }
        }

        const foreignKey = AddSafetyRailsCore1791240000000.ownerForeignKey(name);
        const table = await queryRunner.getTable(name);
        if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
            await queryRunner.createForeignKey(name, foreignKey);
        }
    }

    /**
     * Drop a table only when this migration created it. A table `up()` merely
     * adopted keeps its rows; only the named indexes and foreign key added
     * here come back off.
     */
    private async revertTable(
        queryRunner: QueryRunner,
        name: string,
        indexes: TableIndex[],
    ): Promise<void> {
        if (!(await queryRunner.hasTable(name))) return;
        const table = await queryRunner.getTable(name);
        const created =
            table?.indices.some(
                (index) =>
                    index.name === AddSafetyRailsCore1791240000000.ownershipMarker(name).name,
            ) ?? false;

        if (created) {
            await queryRunner.dropTable(name, true, true, true);
            return;
        }

        const foreignKey = AddSafetyRailsCore1791240000000.ownerForeignKey(name);
        const existingFk = table?.foreignKeys.find((fk) => fk.name === foreignKey.name);
        if (existingFk) await queryRunner.dropForeignKey(name, existingFk);

        for (const index of indexes) {
            const current = await queryRunner.getTable(name);
            const existing = current?.indices.find((idx) => idx.name === index.name);
            if (existing) await queryRunner.dropIndex(name, existing);
        }
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        await this.ensureTable(
            queryRunner,
            'autonomy_grants',
            AddSafetyRailsCore1791240000000.autonomyGrantColumns(isPostgres),
            AddSafetyRailsCore1791240000000.AUTONOMY_GRANT_INDEXES,
        );
        await this.ensureTable(
            queryRunner,
            'rail_refusals',
            AddSafetyRailsCore1791240000000.railRefusalColumns(isPostgres),
            AddSafetyRailsCore1791240000000.RAIL_REFUSAL_INDEXES,
        );
        await this.ensureTable(
            queryRunner,
            'workspace_pauses',
            AddSafetyRailsCore1791240000000.workspacePauseColumns(isPostgres),
            AddSafetyRailsCore1791240000000.WORKSPACE_PAUSE_INDEXES,
        );

        // At most one pause per workspace. Two partial uniques rather than one
        // plain pair, because a NULL organization (the bare-tenant workspace)
        // would otherwise never collide with itself. Both Postgres and the
        // better-sqlite3 test driver accept this `WHERE` form; any other
        // driver falls back to the service's own presence check.
        for (const statement of [
            `CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_pauses_scope" ` +
                `ON "workspace_pauses" ("tenantId", "organizationId") WHERE "organizationId" IS NOT NULL`,
            `CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_pauses_tenant_only" ` +
                `ON "workspace_pauses" ("tenantId") WHERE "organizationId" IS NULL`,
        ]) {
            try {
                await queryRunner.query(statement);
            } catch (error) {
                if (isPostgres) throw error;
                // Best-effort on a driver without partial indexes. Pausing
                // still reads the existing row before inserting, so a second
                // pause updates rather than duplicates.
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "uq_workspace_pauses_tenant_only"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "uq_workspace_pauses_scope"`);

        await this.revertTable(
            queryRunner,
            'workspace_pauses',
            AddSafetyRailsCore1791240000000.WORKSPACE_PAUSE_INDEXES,
        );
        await this.revertTable(
            queryRunner,
            'rail_refusals',
            AddSafetyRailsCore1791240000000.RAIL_REFUSAL_INDEXES,
        );
        await this.revertTable(
            queryRunner,
            'autonomy_grants',
            AddSafetyRailsCore1791240000000.AUTONOMY_GRANT_INDEXES,
        );
    }
}
