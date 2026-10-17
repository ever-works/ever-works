import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * EW-P2-6 — `users.displayName`: an optional human display name ("Ada Lovelace")
 * shown where the `username` handle would be, and served as the integration member
 * DTO's `displayName`. NULL on every existing row (= show the username).
 *
 * Additive and idempotent (guarded); `down` drops the column.
 */
export class AddUserDisplayName1795150000000 implements MigrationInterface {
    name = 'AddUserDisplayName1795150000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('users');
        if (!table || table.findColumnByName('displayName')) return;
        await queryRunner.addColumn(
            'users',
            new TableColumn({
                name: 'displayName',
                type: 'varchar',
                length: '100',
                isNullable: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('users');
        if (table?.findColumnByName('displayName')) {
            await queryRunner.dropColumn('users', 'displayName');
        }
    }
}
