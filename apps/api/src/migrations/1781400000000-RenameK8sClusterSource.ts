import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rename the k8s plugin's `clusterSource` values, atomically, across every
 * scope tier where they may be stored.
 *
 * The cluster-source model was renamed so the value names match the physical
 * clusters:
 *   - old `k8s-gauzy` (Ever Works INTERNAL cluster)  → `k8s-works`
 *   - old `k8s-works` (Ever Works SHARED customer cluster) → `k8s-works-shared`
 *
 * This is a **value collision**: the string `k8s-works` meant "shared" before
 * and means "internal" after. The rename therefore MUST be resolved once, in
 * the data, before any post-rename code reads a stored value — otherwise a
 * stored `k8s-works` is ambiguous. TypeORM runs pending migrations atomically
 * on API boot (`migrationsRun`, `migrationsTransactionMode: 'all'`) before the
 * app serves traffic, so this migration is that one-shot rewrite. After it
 * runs, a stored `k8s-works` unambiguously means the internal cluster and the
 * deploy layer only has to defensively normalise the (non-colliding) legacy
 * `k8s-gauzy` alias.
 *
 * `clusterSource` is a non-secret field, so it lives in plaintext inside the
 * `settings` column (TypeORM `simple-json` → Postgres `text`) of the three
 * plugin-settings tables — `plugins` (global), `user_plugins`, `work_plugins`.
 * A `global`-scoped field can be saved at any tier and the deploy path resolves
 * the full cascade, so all three tables are rewritten. The encrypted
 * `secretSettings`/`kubeconfig` column is never touched.
 *
 * ORDERING IS LOAD-BEARING: within each table we remap `k8s-works` →
 * `k8s-works-shared` FIRST, then `k8s-gauzy` → `k8s-works`. Reversing the order
 * would move the freshly-renamed `k8s-gauzy` rows a second time (into
 * `k8s-works-shared`), corrupting the internal-cluster selections.
 *
 * Postgres-only: `settings` is `text`, so the value must be read/written via a
 * `::jsonb` cast (dev/CI use SQLite + `synchronize`, where this never runs).
 */
export class RenameK8sClusterSource1781400000000 implements MigrationInterface {
    name = 'RenameK8sClusterSource1781400000000';

    /** Tables that carry a k8s `clusterSource` in their `settings` JSON text. */
    private static readonly TABLES = ['plugins', 'user_plugins', 'work_plugins'] as const;

    private async remap(
        queryRunner: QueryRunner,
        table: string,
        fromValue: string,
        toValue: string,
    ): Promise<void> {
        // `to_jsonb($1::text)` writes a proper JSON string; cast the whole
        // object back to `::text` because the column is `text`, not `jsonb`.
        // The predicate skips NULL/empty/`{}`/other-plugin rows and rows whose
        // clusterSource doesn't match, so this is a no-op for everything else.
        await queryRunner.query(
            `UPDATE "${table}"
             SET "settings" = jsonb_set("settings"::jsonb, '{clusterSource}', to_jsonb($1::text))::text
             WHERE "pluginId" = 'k8s'
               AND "settings" IS NOT NULL
               AND "settings" <> ''
               AND ("settings"::jsonb ->> 'clusterSource') = $2`,
            [toValue, fromValue],
        );
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }
        for (const table of RenameK8sClusterSource1781400000000.TABLES) {
            // Order matters — see the class doc. Shared first, then internal.
            await this.remap(queryRunner, table, 'k8s-works', 'k8s-works-shared');
            await this.remap(queryRunner, table, 'k8s-gauzy', 'k8s-works');
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }
        // Best-effort inverse, in reverse order. `k8s-works` → `k8s-gauzy`
        // FIRST (undoing the gauzy→works step), then `k8s-works-shared` →
        // `k8s-works` (undoing the works→shared step). Any `k8s-works-shared`
        // rows created directly after the rename (new customer selections)
        // will be rolled back to the pre-rename `k8s-works` spelling — the
        // reason a revert is only "best effort" for a value-collision rename.
        for (const table of RenameK8sClusterSource1781400000000.TABLES) {
            await this.remap(queryRunner, table, 'k8s-works', 'k8s-gauzy');
            await this.remap(queryRunner, table, 'k8s-works-shared', 'k8s-works');
        }
    }
}
