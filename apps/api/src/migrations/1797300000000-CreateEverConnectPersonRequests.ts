import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Ever Connect — `ever_connect_person_requests`.
 *
 * A connected installation's answer to each deletion or export request Ever
 * Platform made for a person: one row per platform job (`jobId`, unique), the
 * answer decided the first time and `answeredAt` once Ever Platform recorded
 * it. A request delivered again is answered from the row. Identifiers and
 * machine codes only — never a subject, a subject hash, an e-mail or a name.
 *
 * Portable `Table` DDL (CI and e2e run better-sqlite3, production Postgres);
 * each step guarded so a partially applied database converges. `down` drops
 * the table: the answers are already recorded by Ever Platform.
 */
export class CreateEverConnectPersonRequests1797300000000 implements MigrationInterface {
    name = 'CreateEverConnectPersonRequests1797300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('ever_connect_person_requests'))) {
            const isPostgres = queryRunner.connection.options.type === 'postgres';
            await queryRunner.createTable(
                new Table({
                    name: 'ever_connect_person_requests',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'jobId', type: 'varchar', length: '64', isNullable: false },
                        { name: 'eventId', type: 'varchar', length: '64', isNullable: false },
                        { name: 'kind', type: 'varchar', length: '16', isNullable: false },
                        { name: 'result', type: 'varchar', length: '32', isNullable: false },
                        { name: 'reasonCode', type: 'varchar', length: '64', isNullable: true },
                        { name: 'legalBasis', type: 'varchar', length: '200', isNullable: true },
                        { name: 'exportUrl', type: 'varchar', length: '2048', isNullable: true },
                        { name: 'answeredAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const index = new TableIndex({
            name: 'uq_ever_connect_person_requests_job',
            columnNames: ['jobId'],
            isUnique: true,
        });
        // Re-read: an index an earlier, interrupted run created must be seen first.
        const table = await queryRunner.getTable('ever_connect_person_requests');
        if (table && !table.indices.some((existing) => existing.name === index.name)) {
            await queryRunner.createIndex('ever_connect_person_requests', index);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ever_connect_person_requests')) {
            await queryRunner.dropTable('ever_connect_person_requests', true);
        }
    }
}
