import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Access-level ownership on tool grants (AW-15, slot 01).
 *
 * Entity: `packages/agent/src/entities/tool-grant.entity.ts`.
 *
 * ## Why
 *
 * Choosing "Read only" / "Read and write" for a provider writes ordinary deny
 * patterns onto one scope's `tool_grants` row. An operator can deny the very
 * same tool names by hand. Without a record of who added which pattern,
 * choosing "Read and write" would remove the operator's own deny along with
 * the level's — silently dropping a safety control someone set on purpose.
 *
 * `presetOwnership` records, per provider, the level chosen at that scope and
 * exactly the deny patterns the access-level control itself added. A pattern
 * that was already denied when the control first touched the row is not in
 * the record, so no level change ever removes it.
 *
 * ## Shape
 *
 * Nullable TEXT (`simple-json`), matching `allow` / `deny` next door. NULL for
 * every existing row = "the control never touched this row", which is the
 * truth: nothing is backfilled and no existing grant changes meaning.
 * `decideToolGrant` never reads this column.
 *
 * Forward-only and idempotent (`hasColumn` guarded), portable across Postgres
 * (prod) and better-sqlite3 (CI / e2e). `down()` drops only this column.
 */
export class AddToolGrantPresetOwnership1791150100000 implements MigrationInterface {
    name = 'AddToolGrantPresetOwnership1791150100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tool_grants'))) {
            // `1784780000000-CreateToolGrants` has not run; migrations run in
            // timestamp order, so this only happens on a hand-rolled database.
            return;
        }
        if (!(await queryRunner.hasColumn('tool_grants', 'presetOwnership'))) {
            await queryRunner.addColumn(
                'tool_grants',
                new TableColumn({ name: 'presetOwnership', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tool_grants'))) return;
        if (await queryRunner.hasColumn('tool_grants', 'presetOwnership')) {
            await queryRunner.dropColumn('tool_grants', 'presetOwnership');
        }
    }
}
