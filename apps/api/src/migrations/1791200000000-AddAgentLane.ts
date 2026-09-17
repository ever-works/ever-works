import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * First-hour onboarding (AW-20, slot 00) — `agents.lane`.
 *
 * Entity: `packages/agent/src/entities/agent.entity.ts`.
 *
 * A lane is the area of work one Agent owns (`coordination`, `research`,
 * `content`, …). It exists so a surface can ask "who owns research here?"
 * and get a stable answer instead of pattern-matching a free-text title:
 * roster provisioning reads it to decide whether a lane is already
 * filled, and the starter-brief picker reads it to choose an assignee.
 *
 * 🛑 It is a LABEL, not a permission. Nothing in the authorization path
 * may read this column.
 *
 * ## Shape
 *
 * - Nullable `varchar(32)`, no default and no backfill: every Agent that
 *   existed before this migration has no lane and behaves exactly as it
 *   did (Constitution X).
 * - `uq_agents_user_lane` — a PARTIAL unique index on
 *   `("userId", "lane") WHERE "lane" IS NOT NULL`. Partial because the
 *   rule is "one agent per lane per person", and without the predicate
 *   every laneless Agent after the first would collide on NULL in SQLite
 *   (and the index would carry a row per laneless Agent for nothing in
 *   Postgres). Spelled as raw SQL because TypeORM's `TableIndex` has no
 *   partial-index form; `IF NOT EXISTS` is honoured by both Postgres and
 *   better-sqlite3, so the statement is its own idempotency guard.
 *
 * Putting uniqueness in the schema rather than in a service check is
 * deliberate: provisioning is not the only thing that can write a lane,
 * and a second write path must not be able to produce two agents that
 * both claim to own research.
 *
 * Forward-only and idempotent. `down()` drops only what `up()` created.
 */
export class AddAgentLane1791200000000 implements MigrationInterface {
    name = 'AddAgentLane1791200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('agents'))) return;

        if (!(await queryRunner.hasColumn('agents', 'lane'))) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({ name: 'lane', type: 'varchar', length: '32', isNullable: true }),
            );
        }

        await queryRunner.query(
            'CREATE UNIQUE INDEX IF NOT EXISTS "uq_agents_user_lane" ' +
                'ON "agents" ("userId", "lane") WHERE "lane" IS NOT NULL',
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('agents'))) return;

        await queryRunner.query('DROP INDEX IF EXISTS "uq_agents_user_lane"');

        if (await queryRunner.hasColumn('agents', 'lane')) {
            await queryRunner.dropColumn('agents', 'lane');
        }
    }
}
