import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.8.
 *
 * Adds the failure-reason columns to `work_proposals` so the
 * Goal-completion handler (Phase 1 PR FF) can persist WHY an
 * Idea build failed, and the Idea Card UI can surface it inline
 * (spec §3.9, Decisions A23/A24).
 *
 * Columns added on `work_proposals`:
 *
 *   - `failureMessage` (text, NULL)
 *       Human-readable failure reason. Rendered inline on the
 *       Idea Card below the title in a muted-danger block when
 *       the Idea is in FAILED status. NULL otherwise (cleared
 *       by `/retry`).
 *
 *   - `failureKind` (varchar 32, NULL)
 *       Machine-readable classification — one of `IdeaFailureKind`
 *       values (transient-network / transient-rate-limit /
 *       transient-upstream-5xx / transient-plugin /
 *       permanent-invalid-input / permanent-unknown). Drives the
 *       auto-retry decision in the Goal-completion handler:
 *       transient-* kinds are eligible for retry per the user's
 *       `maxAutoRetries` policy; permanent-* kinds skip auto-retry
 *       (manual Retry button still works).
 *
 * Both NULLABLE because every existing Idea is in a non-FAILED
 * status and must stay so. New FAILED transitions populate both.
 *
 * Range / enum validation on `failureKind` happens at the DTO
 * layer in Phase 1 PR FF (consistent with PR 0.5's choice on
 * range bounds — keeps the migration dialect-portable).
 *
 * Idempotent and reversible.
 */
export class AddIdeaFailureColumns1779978007000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('work_proposals', 'failureMessage'))) {
            await queryRunner.addColumn(
                'work_proposals',
                new TableColumn({
                    name: 'failureMessage',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('work_proposals', 'failureKind'))) {
            await queryRunner.addColumn(
                'work_proposals',
                new TableColumn({
                    name: 'failureKind',
                    type: 'varchar',
                    length: '32',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('work_proposals', 'failureKind')) {
            await queryRunner.dropColumn('work_proposals', 'failureKind');
        }
        if (await queryRunner.hasColumn('work_proposals', 'failureMessage')) {
            await queryRunner.dropColumn('work_proposals', 'failureMessage');
        }
    }
}
