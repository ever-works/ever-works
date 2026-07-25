import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Memory recall injection toggles (memory upgrades M2/M3).
 *
 * `agents.memoryRecallEnabled` — per-Agent switch for splicing the
 * fenced agent-memory recall block into task-kind run prompts (M2).
 *
 * `works.memoryRecallEnabled` — per-Work switch for splicing the same
 * block into self-managed pipeline session preambles at dispatch (M3).
 *
 * Both default TRUE — recall is on by default, configurable (the
 * injection is still best-effort and silently skipped when no
 * agent-memory provider is enabled, so existing installs without a
 * provider see zero behavior change).
 *
 * Forward-only, idempotent per-step guards (house pattern — mirrors
 * 1782700000000-AddTaskIsolationColumns).
 */
export class AddMemoryRecallColumns1783000000000 implements MigrationInterface {
    name = 'AddMemoryRecallColumns1783000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const agents = await queryRunner.getTable('agents');
        if (agents && !agents.findColumnByName('memoryRecallEnabled')) {
            await queryRunner.query(
                `ALTER TABLE "agents" ADD COLUMN "memoryRecallEnabled" boolean NOT NULL DEFAULT true`,
            );
        }

        const works = await queryRunner.getTable('works');
        if (works && !works.findColumnByName('memoryRecallEnabled')) {
            await queryRunner.query(
                `ALTER TABLE "works" ADD COLUMN "memoryRecallEnabled" boolean NOT NULL DEFAULT true`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const works = await queryRunner.getTable('works');
        if (works && works.findColumnByName('memoryRecallEnabled')) {
            await queryRunner.query(`ALTER TABLE "works" DROP COLUMN "memoryRecallEnabled"`);
        }
        const agents = await queryRunner.getTable('agents');
        if (agents && agents.findColumnByName('memoryRecallEnabled')) {
            await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "memoryRecallEnabled"`);
        }
    }
}
