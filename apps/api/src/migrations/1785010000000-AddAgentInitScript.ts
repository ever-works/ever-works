import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Capabilities tab — `agents.initScript`.
 *
 * Per-Agent bootstrap script edited on the new Capabilities tab.
 * ADVISORY in v1: the column is persisted and surfaced through
 * `GET /api/agents/:id/capabilities`; execution paths consume it as they
 * gain a session/workspace bootstrap seam. Capped at 16 KB and
 * secret-scanned (hard-reject) in `AgentsService.update` — the DB stores
 * whatever passed those write-path gates.
 *
 * **Nothing is backfilled.** Every existing Agent keeps NULL, which every
 * reader treats as "no init script" — the exact pre-feature behaviour.
 *
 * No index: the column is only ever read by primary-key lookup of the
 * Agent row, never filtered or sorted on.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784800000000-AddTaskDelegationDepth). `text` is portable across
 * postgres + better-sqlite3.
 */
export class AddAgentInitScript1785010000000 implements MigrationInterface {
    name = 'AddAgentInitScript1785010000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agents');
        if (!table) return;

        if (!table.findColumnByName('initScript')) {
            await queryRunner.query(`ALTER TABLE "agents" ADD COLUMN "initScript" text`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agents');
        if (!table) return;

        // Dropping loses operator-authored content, but the column is
        // advisory in v1 (nothing executes it yet), so revert is safe in
        // the same sense the entity's other nullable text columns are.
        if (table.findColumnByName('initScript')) {
            await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "initScript"`);
        }
    }
}
