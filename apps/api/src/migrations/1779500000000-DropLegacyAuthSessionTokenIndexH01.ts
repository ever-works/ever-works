import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * H-01 (sessions) follow-up — drop the dead unique index on `session.token`.
 *
 * After `1779300000000-HashAuthSessionTokensH01`, every new session row
 * writes `token = NULL` and the live lookup index is `IDX_session_tokenHash`.
 * The legacy `@Index(['token'], { unique: true })` decorator therefore
 * indexes a column that's always NULL on new writes. On SQLite (and any
 * other engine that treats NULLs as equal under a unique constraint) two
 * concurrent new sessions would race into a spurious uniqueness violation.
 *
 * This migration drops that index. The `token` column itself stays — it's
 * still readable for rows written before H-01 — but the unique constraint
 * is gone. The `AuthSession` entity also drops the `@Index` decorator in
 * the same change so a fresh `synchronize` doesn't re-create it.
 */
export class DropLegacyAuthSessionTokenIndexH01_1779500000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // TypeORM auto-names indexes deterministically from table+columns
        // (`IDX_<sha1-prefix>`), and the exact name varies if anyone has
        // ever renamed the index out-of-band. Look it up by columns so the
        // migration works against any historical schema.
        const table = await queryRunner.getTable('session');
        if (!table) {
            // No `session` table to clean — nothing to do (likely a brand-new
            // database that ran every migration up to here in one shot).
            return;
        }
        const tokenIndex = table.indices.find(
            (idx) => idx.isUnique && idx.columnNames.length === 1 && idx.columnNames[0] === 'token',
        );
        if (tokenIndex) {
            await queryRunner.dropIndex('session', tokenIndex);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Re-create the legacy unique index so a rollback restores the prior
        // schema shape. Existing NULL `token` rows survive on engines that
        // exclude NULLs from uniqueness (Postgres); on engines that don't
        // (e.g. older SQLite), a rollback after live H-01 traffic will fail
        // — that's acceptable, the index is what we're trying to get rid of.
        await queryRunner.createIndex(
            'session',
            new TableIndex({
                columnNames: ['token'],
                isUnique: true,
            }),
        );
    }
}
