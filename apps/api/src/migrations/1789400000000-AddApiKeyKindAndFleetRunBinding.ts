import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Self-build slice Z (EW-796) — `api_keys.kind` plus the fleet-run
 * binding columns behind the node MCP bridge.
 *
 * ## Why these columns and not a new table
 *
 * A run-scoped MCP credential is an API key in every respect that
 * matters: sha256 at rest, an owner, an Organization, an expiry, and an
 * `isActive` flag that IS the revoke switch (`findByHashedKey` already
 * filters on it). A second table would have meant a second hash lookup,
 * a second expiry check and a second revoke path — three places for the
 * two to drift. So the row is reused and a discriminator is added.
 *
 * ## What existing rows read as
 *
 * `kind` is `varchar(32) NOT NULL DEFAULT 'personal'`, so the DEFAULT
 * backfills every existing key inside the same `ALTER TABLE` on Postgres
 * and better-sqlite3 alike (the mechanism 1788700000000 relies on for
 * `goals.goalKind`). No UPDATE pass, and every key a user created before
 * this migration keeps behaving exactly as it always did — it still
 * lists in Settings > API Keys and still counts toward the ten-key cap,
 * both of which now filter on `kind = 'personal'`.
 *
 * The three binding columns are nullable and stay NULL on every personal
 * key. They are only ever written by `FleetRunCredentialService.mint`.
 *
 * ## The index
 *
 * `idx_api_keys_bound_job` backs the two hot paths of the bridge:
 * rotation (deactivate the predecessors of one job) and
 * revoke-on-finalize. Both are `WHERE boundJobId = ?`, run on every
 * lease renewal and every job completion, and would otherwise be a full
 * scan of a table that grows with every run.
 *
 * ## Portability
 *
 * Raw `ALTER TABLE … ADD COLUMN` with a literal DEFAULT for `kind` (the
 * one column that must be NOT NULL and therefore needs the backfill);
 * plain nullable adds for the rest. `uuid` is a real type on Postgres
 * and an alias sqlite accepts, exactly as 1779991006000 already relies
 * on for `api_keys.tenantId` / `organizationId`. Every step is guarded
 * by `findColumnByName` / `indices`, so re-running is a no-op.
 */
export class AddApiKeyKindAndFleetRunBinding1789400000000 implements MigrationInterface {
    name = 'AddApiKeyKindAndFleetRunBinding1789400000000';

    private static readonly TABLE = 'api_keys';
    private static readonly BOUND_JOB_INDEX = 'idx_api_keys_bound_job';
    /** The nullable binding columns, all `uuid`, all NULL on a personal key. */
    private static readonly BINDING_COLUMNS = ['boundJobId', 'boundNodeId', 'boundRunId'];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(
            AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
        );
        if (!table) return;

        if (!table.findColumnByName('kind')) {
            await queryRunner.query(
                `ALTER TABLE "api_keys" ADD COLUMN "kind" varchar(32) NOT NULL DEFAULT 'personal'`,
            );
        }

        for (const name of AddApiKeyKindAndFleetRunBinding1789400000000.BINDING_COLUMNS) {
            // Re-read on every step: adding a column can recreate the table
            // on the sqlite driver, so a descriptor captured before it is
            // stale (same reason 1788700000000 re-reads).
            const refreshed = await queryRunner.getTable(
                AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
            );
            if (refreshed?.findColumnByName(name)) continue;
            await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "${name}" uuid`);
        }

        const withColumns = await queryRunner.getTable(
            AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
        );
        const hasIndex = withColumns?.indices.some(
            (index) =>
                index.name === AddApiKeyKindAndFleetRunBinding1789400000000.BOUND_JOB_INDEX ||
                (index.columnNames.length === 1 && index.columnNames[0] === 'boundJobId'),
        );
        if (withColumns && !hasIndex) {
            await queryRunner.createIndex(
                AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
                new TableIndex({
                    name: AddApiKeyKindAndFleetRunBinding1789400000000.BOUND_JOB_INDEX,
                    columnNames: ['boundJobId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(
            AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
        );
        if (!table) return;

        // Reverting REMOVES every fleet-run credential: they exist only
        // because of this migration (no such row can predate it), and the
        // columns that make them safe — the job and node bindings — are
        // about to be dropped. Leaving them behind as indistinguishable
        // `personal` keys would be the unsafe outcome, so they go.
        if (table.findColumnByName('kind')) {
            await queryRunner.query(`DELETE FROM "api_keys" WHERE "kind" = 'fleet-run'`);
        }

        const hasIndex = table.indices.find(
            (index) =>
                index.name === AddApiKeyKindAndFleetRunBinding1789400000000.BOUND_JOB_INDEX ||
                (index.columnNames.length === 1 && index.columnNames[0] === 'boundJobId'),
        );
        if (hasIndex) {
            await queryRunner.dropIndex(
                AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
                hasIndex,
            );
        }

        for (const name of [
            ...AddApiKeyKindAndFleetRunBinding1789400000000.BINDING_COLUMNS,
            'kind',
        ]) {
            // TypeORM's own primitive rather than a raw DROP COLUMN: sqlite
            // only learned that statement in 3.35, and TypeORM drops a
            // column there by recreating the table — which also keeps the
            // runner's metadata in step for anything that runs after this.
            const refreshed = await queryRunner.getTable(
                AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
            );
            const column = refreshed?.findColumnByName(name);
            if (!column) continue;
            await queryRunner.dropColumn(
                AddApiKeyKindAndFleetRunBinding1789400000000.TABLE,
                column,
            );
        }
    }
}
