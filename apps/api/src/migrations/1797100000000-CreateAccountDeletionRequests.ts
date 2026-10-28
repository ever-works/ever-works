import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Self-serve account deletion — `account_deletion_requests`.
 *
 * One row per deletion request. The public email-link flow writes a `pending`
 * row holding only `sha256(token)` (the raw token exists only in the email),
 * a 30-minute `expiresAt`, and `sha256(lower(email))`. The confirm POST claims
 * the row with one conditional UPDATE (`pending` and unexpired → `consumed`),
 * which is what makes a link single-use. The in-product delete writes its row
 * straight as `completed`.
 *
 * Once a deletion completes the row IS the audit record: hashed email,
 * timestamps and counts. `userId` is cleared then, and it has no foreign key on
 * purpose — the row has to outlive the account it deleted.
 *
 * Portable `Table` DDL (CI and e2e run better-sqlite3, production Postgres);
 * each step guarded so a partially applied database converges. Forward-only:
 * `down` keeps the table and its rows (they are the audit trail).
 */
export class CreateAccountDeletionRequests1797100000000 implements MigrationInterface {
    name = 'CreateAccountDeletionRequests1797100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('account_deletion_requests'))) {
            const isPostgres = queryRunner.connection.options.type === 'postgres';
            await queryRunner.createTable(
                new Table({
                    name: 'account_deletion_requests',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'source', type: 'varchar', length: '16', isNullable: false },
                        { name: 'emailHash', type: 'varchar', length: '64', isNullable: false },
                        { name: 'tokenHash', type: 'varchar', length: '64', isNullable: true },
                        { name: 'userId', type: 'uuid', isNullable: true },
                        {
                            name: 'status',
                            type: 'varchar',
                            length: '16',
                            isNullable: false,
                            default: "'pending'",
                        },
                        { name: 'expiresAt', type: 'timestamp', isNullable: true },
                        { name: 'consumedAt', type: 'timestamp', isNullable: true },
                        { name: 'completedAt', type: 'timestamp', isNullable: true },
                        { name: 'summary', type: 'text', isNullable: true },
                        { name: 'failureCode', type: 'varchar', length: '64', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const indices: TableIndex[] = [
            new TableIndex({
                name: 'idx_account_deletion_requests_token_hash',
                columnNames: ['tokenHash'],
                isUnique: true,
            }),
            new TableIndex({
                name: 'idx_account_deletion_requests_email_created',
                columnNames: ['emailHash', 'createdAt'],
            }),
            new TableIndex({
                name: 'idx_account_deletion_requests_status',
                columnNames: ['status'],
            }),
        ];
        for (const index of indices) {
            // Re-read per step: an index an earlier, interrupted run created must be seen first.
            const table = await queryRunner.getTable('account_deletion_requests');
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex('account_deletion_requests', index);
            }
        }
    }

    /**
     * Intentionally forward-only: the rows are the deletion audit trail and a
     * rollback of the application must not erase them.
     */
    public async down(_queryRunner: QueryRunner): Promise<void> {}
}
