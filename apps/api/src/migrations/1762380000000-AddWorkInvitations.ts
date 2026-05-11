import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

/**
 * Adds the `work_invitations` table backing EW-600 claim/transfer flow.
 * Forward-only, additive. No changes to existing tables.
 */
export class AddWorkInvitations1762380000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'work_invitations',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'workId', type: 'uuid' },
                    { name: 'email', type: 'varchar', length: '320', isNullable: true },
                    { name: 'role', type: 'varchar', length: '32' },
                    { name: 'tokenHash', type: 'varchar', length: '64' },
                    { name: 'tokenExpiresAt', type: 'timestamp with time zone' },
                    { name: 'invitedById', type: 'uuid' },
                    {
                        name: 'status',
                        type: 'varchar',
                        length: '16',
                        default: `'pending'`,
                    },
                    { name: 'acceptedByUserId', type: 'uuid', isNullable: true },
                    {
                        name: 'acceptedAt',
                        type: 'timestamp with time zone',
                        isNullable: true,
                    },
                    { name: 'transferState', type: 'jsonb', isNullable: true },
                    { name: 'metadata', type: 'jsonb', isNullable: true },
                    {
                        name: 'createdAt',
                        type: 'timestamp with time zone',
                        default: 'now()',
                    },
                    {
                        name: 'updatedAt',
                        type: 'timestamp with time zone',
                        default: 'now()',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'work_invitations',
            new TableIndex({
                name: 'IDX_work_invitations_tokenHash',
                columnNames: ['tokenHash'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'work_invitations',
            new TableIndex({
                name: 'IDX_work_invitations_workId',
                columnNames: ['workId'],
            }),
        );

        await queryRunner.createIndex(
            'work_invitations',
            new TableIndex({
                name: 'IDX_work_invitations_status',
                columnNames: ['status'],
            }),
        );

        await queryRunner.createForeignKey(
            'work_invitations',
            new TableForeignKey({
                name: 'FK_work_invitations_workId',
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createForeignKey(
            'work_invitations',
            new TableForeignKey({
                name: 'FK_work_invitations_invitedById',
                columnNames: ['invitedById'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createForeignKey(
            'work_invitations',
            new TableForeignKey({
                name: 'FK_work_invitations_acceptedByUserId',
                columnNames: ['acceptedByUserId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('work_invitations', true);
    }
}
