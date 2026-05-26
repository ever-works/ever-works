import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.5.
 *
 * Adds two opt-in flags to the `users` table for the new
 * AGENT + TASK notification categories. Default off so new users
 * don't get flooded with email; in-app notifications continue to
 * fire regardless. Idempotent: gates on `hasColumn`.
 */
export class AddNotificationEmailOptIns1779978015000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('users', 'emailAgentAlerts'))) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'emailAgentAlerts',
                    type: 'boolean',
                    isNullable: false,
                    default: false,
                }),
            );
        }
        if (!(await queryRunner.hasColumn('users', 'emailTaskNotifications'))) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'emailTaskNotifications',
                    type: 'boolean',
                    isNullable: false,
                    default: false,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const col of ['emailTaskNotifications', 'emailAgentAlerts']) {
            if (await queryRunner.hasColumn('users', col)) {
                await queryRunner.dropColumn('users', col);
            }
        }
    }
}
