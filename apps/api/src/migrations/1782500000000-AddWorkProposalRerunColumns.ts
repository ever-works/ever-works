import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 0.3 (build program) — Ideas can RE-RUN an existing Work.
 *
 * Adds to `work_proposals`:
 *   - `targetWorkId` uuid NULL — when set, building the Idea re-runs
 *     generation on that Work instead of creating a new one. FK →
 *     `works.id` ON DELETE SET NULL (mirrors `acceptedWorkId`).
 *   - `extraPrompt`  text NULL — extra instruction appended to the
 *     Idea description at build time.
 *
 * Forward-only and idempotent: each step guards on its own existence so
 * a partially-applied run (or a re-run after a crash) converges. The
 * FK guard is separate from the column guard — a column added by an
 * earlier partial run still gets its constraint.
 */
export class AddWorkProposalRerunColumns1782500000000 implements MigrationInterface {
    name = 'AddWorkProposalRerunColumns1782500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('work_proposals');
        if (!table) return;

        if (!table.findColumnByName('targetWorkId')) {
            await queryRunner.query(`ALTER TABLE "work_proposals" ADD COLUMN "targetWorkId" uuid`);
        }
        if (!table.findColumnByName('extraPrompt')) {
            await queryRunner.query(`ALTER TABLE "work_proposals" ADD COLUMN "extraPrompt" text`);
        }

        const withColumns = await queryRunner.getTable('work_proposals');
        const hasFk = withColumns?.foreignKeys.some((fk) =>
            fk.columnNames.includes('targetWorkId'),
        );
        if (!hasFk) {
            await queryRunner.query(
                `ALTER TABLE "work_proposals" ADD CONSTRAINT "FK_work_proposals_targetWorkId" ` +
                    `FOREIGN KEY ("targetWorkId") REFERENCES "works"("id") ON DELETE SET NULL`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('work_proposals');
        if (!table) return;
        const fk = table.foreignKeys.find((f) => f.columnNames.includes('targetWorkId'));
        if (fk) {
            await queryRunner.dropForeignKey('work_proposals', fk);
        }
        if (table.findColumnByName('extraPrompt')) {
            await queryRunner.query(`ALTER TABLE "work_proposals" DROP COLUMN "extraPrompt"`);
        }
        if (table.findColumnByName('targetWorkId')) {
            await queryRunner.query(`ALTER TABLE "work_proposals" DROP COLUMN "targetWorkId"`);
        }
    }
}
