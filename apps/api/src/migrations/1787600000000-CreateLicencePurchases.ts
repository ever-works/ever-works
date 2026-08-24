import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Durable self-hosted commercial-licence ownership.
 *
 * The table starts empty and is written only after a billing-verified one-off
 * payment. It is separate from `user_subscriptions`: a licence applies to the
 * buyer's own deployment and must never grant a hosted tier.
 *
 * `down` deliberately preserves financial records. Behavioral rollback can
 * stop readers/writers while retaining the audit trail.
 */
export class CreateLicencePurchases1787600000000 implements MigrationInterface {
    name = 'CreateLicencePurchases1787600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('licence_purchases')) return;

        await queryRunner.createTable(
            new Table({
                name: 'licence_purchases',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'planCode', type: 'varchar', length: '64' },
                    { name: 'provider', type: 'varchar', length: '32' },
                    { name: 'providerPaymentId', type: 'varchar', length: '128' },
                    { name: 'amountCents', type: 'int' },
                    { name: 'currency', type: 'varchar', length: '8' },
                    { name: 'status', type: 'varchar', length: '16', default: "'active'" },
                    { name: 'refundedAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );
        await queryRunner.createIndex(
            'licence_purchases',
            new TableIndex({
                name: 'idx_licence_purchases_user_plan',
                columnNames: ['userId', 'planCode'],
            }),
        );
        await queryRunner.createIndex(
            'licence_purchases',
            new TableIndex({
                name: 'idx_licence_purchases_provider_payment',
                columnNames: ['provider', 'providerPaymentId'],
                isUnique: true,
            }),
        );
        await queryRunner.createForeignKey(
            'licence_purchases',
            new TableForeignKey({
                name: 'fk_licence_purchases_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Financial/audit records are intentionally retained.
    }
}
