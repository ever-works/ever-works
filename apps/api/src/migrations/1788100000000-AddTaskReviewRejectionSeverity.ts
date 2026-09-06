import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Trusted review bots (self-build fleet, finding R16) —
 * `task_review_rejections.severity` + `.reviewerKind`.
 *
 * The GitHub bridge now records reviews, inline findings and summary
 * comments from allow-listed reviewer bots (CodeRabbit, Copilot, Codex,
 * Greptile) as rejection feedback, next to the human rejections it always
 * recorded. Two things a resumed run needs to know about such a row that
 * the schema could not say:
 *
 *   * `reviewerKind` — `human` | `bot`. The seeded prompt labels an
 *     automated finding as such, so the model weighs it as a reviewer
 *     bot's opinion rather than the owner's instruction.
 *   * `severity` — `critical` | `major` | `minor`, parsed from the bot's
 *     own marker (CodeRabbit's `_🟠 Major_`, Codex/Greptile `P1..P3`).
 *     The house rule is "fix P2+ before the PR is clean"; without this
 *     column a nit and a data-loss bug would replay as equals.
 *
 * Both nullable: every existing row and every non-bot writer reads NULL,
 * which is the honest history ("a human, severity not stated"). No index —
 * rows are read by Task through the existing pending-lookup index.
 * Forward-only with a guard so a partially applied database converges;
 * portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddTaskReviewRejectionSeverity1788100000000 implements MigrationInterface {
    name = 'AddTaskReviewRejectionSeverity1788100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const rejections = await queryRunner.getTable('task_review_rejections');
        if (!rejections) return;
        if (!rejections.findColumnByName('severity')) {
            await queryRunner.addColumn(
                'task_review_rejections',
                new TableColumn({
                    name: 'severity',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                }),
            );
        }
        if (!rejections.findColumnByName('reviewerKind')) {
            await queryRunner.addColumn(
                'task_review_rejections',
                new TableColumn({
                    name: 'reviewerKind',
                    type: 'varchar',
                    length: '8',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rejections = await queryRunner.getTable('task_review_rejections');
        if (!rejections) return;
        if (rejections.findColumnByName('reviewerKind')) {
            await queryRunner.dropColumn('task_review_rejections', 'reviewerKind');
        }
        if (rejections.findColumnByName('severity')) {
            await queryRunner.dropColumn('task_review_rejections', 'severity');
        }
    }
}
