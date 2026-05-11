import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds the server-side state columns for the v2 onboarding wizard:
 *
 *  - `onboardingCompletedAt` — set automatically once the user has at
 *    least one Work AND every chosen vendor has the credentials it needs.
 *  - `onboardingDismissedAt` — set when the user clicks "Close wizard".
 *  - `onboardingState` — JSON blob with the user's choices, last viewed
 *    step, and the list of skipped step IDs. Stored as `simple-json` so
 *    it works on both Postgres (text) and SQLite without conditional logic.
 */
export class AddUserOnboardingState1762309000000 implements MigrationInterface {
    name = 'AddUserOnboardingState1762309000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('users');
        if (!table) {
            return;
        }

        if (!table.findColumnByName('onboardingCompletedAt')) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'onboardingCompletedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
            );
        }

        if (!table.findColumnByName('onboardingDismissedAt')) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'onboardingDismissedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
            );
        }

        if (!table.findColumnByName('onboardingState')) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'onboardingState',
                    // simple-json on TypeORM serialises to TEXT on SQLite and
                    // VARCHAR on Postgres — both work for our payload size.
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('users');
        if (!table) {
            return;
        }

        if (table.findColumnByName('onboardingState')) {
            await queryRunner.dropColumn('users', 'onboardingState');
        }
        if (table.findColumnByName('onboardingDismissedAt')) {
            await queryRunner.dropColumn('users', 'onboardingDismissedAt');
        }
        if (table.findColumnByName('onboardingCompletedAt')) {
            await queryRunner.dropColumn('users', 'onboardingCompletedAt');
        }
    }
}
