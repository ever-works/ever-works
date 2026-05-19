import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * EW-602 — Adds two boolean columns to `users`:
 *   - isPlatformAdmin (default false) — self-hosted cross-user admin
 *     access (admin/usage view + future admin endpoints).
 *   - emailBudgetAlerts (default true) — per-user opt-in for budget
 *     threshold-alert emails. The in-app notification always fires;
 *     this only gates the email channel.
 *
 * Forward-only, additive; existing rows pick up the defaults so no
 * backfill is needed.
 */
export class AddUserPlatformAdminAndBudgetAlertEmail1778871104492 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns = [
            new TableColumn({
                name: 'isPlatformAdmin',
                type: 'boolean',
                default: false,
                isNullable: false,
            }),
            new TableColumn({
                name: 'emailBudgetAlerts',
                type: 'boolean',
                default: true,
                isNullable: false,
            }),
        ];

        for (const column of columns) {
            if (!(await queryRunner.hasColumn('users', column.name))) {
                await queryRunner.addColumn('users', column);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const columnName of ['emailBudgetAlerts', 'isPlatformAdmin']) {
            if (await queryRunner.hasColumn('users', columnName)) {
                await queryRunner.dropColumn('users', columnName);
            }
        }
    }
}
