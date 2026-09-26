import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * APW-06 T16/T18 — adds the six App columns to `work_deployments`.
 *
 * Entity: `packages/agent/src/entities/work-deployment.entity.ts`
 * Plan: `docs/specs/features/app-works/APW-06-app-runtime/plan.md` §7.1 (the
 * column table) and §7.3, which names this exact filename and slot.
 *
 * Slot **00 of epic 06** in the programme's reserved `1792` block, which is
 * where §7.3 puts it: below `1792060100000-CreateWorkAppRuntimeStates.ts` and
 * above `1792050000000-CreateWorkBuilds.ts`. That slot was left deliberately
 * free when T17 landed, with a note saying why — the columns did not exist on
 * the entity yet, and a migration for an entity change nobody has made is a
 * schema the code cannot use. They exist now.
 *
 * ## Why this is the second half of "an App Work cannot deploy"
 *
 * `AppDeployRequestService` creates its Deployment row through
 * `APP_DEPLOY_DEPLOYMENT_STORE` with a draft carrying `buildId`, `appTarget`,
 * `appTrigger` and `appRender` (`app-deploy-request.service.ts:290-315`). None
 * of those was a column, so the draft could not be stored: bound to the
 * repository as-is, TypeORM would drop the four silently and the row would say
 * nothing about which Build ran, which cluster it went to, why it ran, or what
 * the render decided. §2.2 step 4 is that row.
 *
 * ## What `up()` does, and nothing else
 *
 * Six `ADD COLUMN`s, every one **nullable with no default**, plus one index on
 * `buildId`. Nothing is renamed, dropped, narrowed or backfilled (CONTRACTS
 * R-26, the owner's additive-only rule). A website Deployment writes none of
 * these and reads exactly as it did before; existing rows keep every value they
 * have and gain six nulls.
 *
 * ## Why `text` and not `jsonb` for the three JSON columns
 *
 * The entity declares them `simple-json`, which TypeORM stores as **text** and
 * (de)serialises itself, on every driver. The API boots against Postgres in
 * production and better-sqlite3 in tests, and `jsonb` exists only on one of
 * them — a `jsonb` column here would make the test DataSource unable to
 * synchronise the entity, which is the failure `TimestampColumn` exists to avoid
 * for dates. Nothing queries inside these documents; they are read whole.
 *
 * ## No index on `appTarget` or `appTrigger`
 *
 * Both are read off a row already found by `id` or by `workId` — never searched.
 * `buildId` is the one that IS searched ("was this Build ever deployed?"), and
 * it is the only one §7.1 marks indexed.
 *
 * `down()` drops the index and the six columns and touches nothing else.
 */
export class ExtendWorkDeploymentsForApps1792060000000 implements MigrationInterface {
    name = 'ExtendWorkDeploymentsForApps1792060000000';

    private static readonly TABLE = 'work_deployments';
    private static readonly INDEX = 'idx_work_deployments_build';

    /**
     * The six columns, in the order the entity declares them.
     *
     * Built fresh per call rather than held as a module constant: `TableColumn`
     * instances are mutable and TypeORM's drivers read them during
     * `addColumns`, so sharing one array between `up` and `down` would hand the
     * second run objects the first has already touched.
     */
    private static columns(): TableColumn[] {
        return [
            new TableColumn({ name: 'buildId', type: 'uuid', isNullable: true }),
            new TableColumn({
                name: 'appTarget',
                type: 'varchar',
                length: '24',
                isNullable: true,
            }),
            new TableColumn({
                name: 'appTrigger',
                type: 'varchar',
                length: '24',
                isNullable: true,
            }),
            // `simple-json` — see the header on why these are `text`.
            new TableColumn({ name: 'componentStatuses', type: 'text', isNullable: true }),
            new TableColumn({ name: 'smokeResult', type: 'text', isNullable: true }),
            new TableColumn({ name: 'appRender', type: 'text', isNullable: true }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(ExtendWorkDeploymentsForApps1792060000000.TABLE);
        if (!table) {
            // The table is created by the deploy-history migration that predates
            // this epic. If it is absent the database is older than this
            // migration expects, and adding columns to nothing would fail with a
            // message that says less than this one.
            throw new Error(
                `${ExtendWorkDeploymentsForApps1792060000000.TABLE} does not exist; ` +
                    'run the earlier migrations before this one.',
            );
        }

        // Idempotent per column, not per migration: a database that was
        // synchronised from the entity (a dev box, a test DataSource) already has
        // some or all of these, and re-adding one is an error rather than a
        // no-op. Filtering here means the migration converges from either state.
        const missing = ExtendWorkDeploymentsForApps1792060000000.columns().filter(
            (column) => !table.findColumnByName(column.name),
        );
        if (missing.length > 0) {
            await queryRunner.addColumns(ExtendWorkDeploymentsForApps1792060000000.TABLE, missing);
        }

        const hasIndex = table.indices.some(
            (index) => index.name === ExtendWorkDeploymentsForApps1792060000000.INDEX,
        );
        if (!hasIndex) {
            await queryRunner.createIndex(
                ExtendWorkDeploymentsForApps1792060000000.TABLE,
                new TableIndex({
                    name: ExtendWorkDeploymentsForApps1792060000000.INDEX,
                    columnNames: ['buildId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(ExtendWorkDeploymentsForApps1792060000000.TABLE);
        if (!table) return;

        if (
            table.indices.some(
                (index) => index.name === ExtendWorkDeploymentsForApps1792060000000.INDEX,
            )
        ) {
            await queryRunner.dropIndex(
                ExtendWorkDeploymentsForApps1792060000000.TABLE,
                ExtendWorkDeploymentsForApps1792060000000.INDEX,
            );
        }

        // Only the columns this migration added, and only the ones still there.
        const present = ExtendWorkDeploymentsForApps1792060000000.columns().filter((column) =>
            table.findColumnByName(column.name),
        );
        if (present.length > 0) {
            await queryRunner.dropColumns(ExtendWorkDeploymentsForApps1792060000000.TABLE, present);
        }
    }
}
