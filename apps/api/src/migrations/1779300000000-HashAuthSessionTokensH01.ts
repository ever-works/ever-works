import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * H-01 (sessions) — at-rest hashing for `AuthSession.token`.
 *
 * Before this commit, every active session bearer was stored verbatim in
 * `session.token`. A read of that table — DB backup leaked, replica
 * compromise, accidental log of a SELECT *, etc. — handed the attacker
 * every live user's bearer.
 *
 * After this commit, the application writes `sha256(token)` into a new
 * `tokenHash` column and looks up by that hash on every authenticated
 * request. The raw token only ever travels in the response body / the
 * `Authorization: Bearer …` header.
 *
 * Migration steps:
 *
 *   1. Make the legacy `token` column nullable so older rows survive and
 *      new rows can persist `null` there.
 *   2. Add the new `tokenHash` column (nullable + unique index — uniqueness
 *      surfaces accidental collisions as a write error rather than silent
 *      session overlap).
 *   3. Null every existing `session.token` value. Same invalidate-on-deploy
 *      posture the operator already authorized for the email/reset tokens
 *      in `1779200000000-InvalidateLegacyAuthTokensH01`. The handful of
 *      currently-active users will be logged out and have to re-auth on
 *      next request — fine.
 *
 * `tokenHash` is intentionally **not** backfilled. There's nothing safe to
 * backfill it from (we don't have the raw tokens), and the lookup path now
 * keys on `tokenHash` so any session row with `tokenHash IS NULL` is
 * already effectively dead.
 */
export class HashAuthSessionTokensH01_1779300000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Drop NOT NULL on the legacy plaintext column.
        await queryRunner.query(`
            ALTER TABLE "session"
            ALTER COLUMN "token" DROP NOT NULL
        `);

        // 2. Add `tokenHash` (nullable, unique).
        await queryRunner.addColumn(
            'session',
            new TableColumn({
                name: 'tokenHash',
                type: 'varchar',
                isNullable: true,
            }),
        );

        await queryRunner.createIndex(
            'session',
            new TableIndex({
                name: 'IDX_session_tokenHash',
                columnNames: ['tokenHash'],
                isUnique: true,
            }),
        );

        // 3. Invalidate every in-flight bearer. The application code stops
        //    looking up by `token` after this deploy; any value left here
        //    is dead weight that we deliberately scrub.
        await queryRunner.query(`
            UPDATE "session"
               SET "token" = NULL
             WHERE "token" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Irreversible by design: the plaintext bearers are gone. We still
        // unwind the schema so a rollback isn't completely stuck.
        await queryRunner.dropIndex('session', 'IDX_session_tokenHash');
        await queryRunner.dropColumn('session', 'tokenHash');
        // We do NOT re-add NOT NULL to `token` — the column may legitimately
        // contain NULL rows now and a reverse migration shouldn't fail on
        // them.
    }
}
