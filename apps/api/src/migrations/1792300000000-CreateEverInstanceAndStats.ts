import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Anonymous usage statistics — the three instance-wide tables of the module:
 *
 * - `ever_instance` — ONE row (`id = 'self'`): the installation's opaque
 *   `instanceId`, its statistics-only Ed25519 key pair (the private key stored
 *   wrapped), the operator's switch (`statsEnabledUi`, default on), the reset
 *   counter, and three empty, nullable columns reserved for the separate
 *   connection key.
 * - `ever_stats_report` — the last 12 send attempts, each with the EXACT body
 *   that was posted (`payload`), its size, the outcome and the receiver's
 *   field errors (paths and codes only).
 * - `ever_stats_lease` — ONE row: the shared schedule (`nextSendAt`, the
 *   failure count, the module version a refused report is parked on) and the
 *   compare-and-set lease that keeps N replicas to one report.
 *
 * Entities: `packages/agent/src/entities/ever-instance.entity.ts`,
 * `ever-stats-report.entity.ts`, `ever-stats-lease.entity.ts`.
 *
 * No row is written here: the module creates the instance row on its first
 * boot (and never when it is switched off with `EVER_STATS_ENABLED=false`).
 * None of the tables has a tenant, organization or user column.
 *
 * ## Idempotent, portable, reversible
 *
 * Every step is guarded (`hasTable`, existing index names), so a re-run is a
 * no-op and `down()` is safe where `up()` never ran. Timestamps default to
 * `CURRENT_TIMESTAMP` (portable to the better-sqlite3 driver the specs and the
 * e2e lane use). `down()` drops exactly the three tables `up()` created;
 * nothing else depends on them.
 */
export class CreateEverInstanceAndStats1792300000000 implements MigrationInterface {
    name = 'CreateEverInstanceAndStats1792300000000';

    private static readonly INSTANCE = 'ever_instance';
    private static readonly REPORT = 'ever_stats_report';
    private static readonly LEASE = 'ever_stats_lease';
    private static readonly REPORT_INDEX = 'idx_ever_stats_report_attempted';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const self = CreateEverInstanceAndStats1792300000000;

        if (!(await queryRunner.hasTable(self.INSTANCE))) {
            await queryRunner.createTable(
                new Table({
                    name: self.INSTANCE,
                    columns: [
                        { name: 'id', type: 'varchar', length: '16', isPrimary: true },
                        { name: 'instanceId', type: 'uuid' },
                        { name: 'statsPublicKey', type: 'varchar', length: '64' },
                        { name: 'statsPrivateKeyEncrypted', type: 'text' },
                        { name: 'statsKeyId', type: 'varchar', length: '16' },
                        // Reserved for the connection module's own key; never written here.
                        {
                            name: 'connectPublicKey',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'connectPrivateKeyEncrypted', type: 'text', isNullable: true },
                        { name: 'connectKeyId', type: 'varchar', length: '16', isNullable: true },
                        { name: 'statsEnabledUi', type: 'boolean', default: true },
                        { name: 'resetCount', type: 'int', default: 0 },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        if (!(await queryRunner.hasTable(self.REPORT))) {
            await queryRunner.createTable(
                new Table({
                    name: self.REPORT,
                    columns: [
                        { name: 'reportId', type: 'uuid', isPrimary: true },
                        { name: 'period', type: 'varchar', length: '7' },
                        { name: 'final', type: 'boolean', default: false },
                        // The exact body that was posted.
                        { name: 'payload', type: 'text' },
                        { name: 'bytes', type: 'int' },
                        // 'sent' | 'rejected' | 'failed'.
                        { name: 'status', type: 'varchar', length: '16' },
                        { name: 'httpStatus', type: 'int', isNullable: true },
                        { name: 'errorCode', type: 'varchar', length: '32', isNullable: true },
                        // `[{ path, code }]` — schema pointers and closed codes, never a value.
                        { name: 'errors', type: 'text', isNullable: true },
                        { name: 'attempt', type: 'int', default: 1 },
                        { name: 'moduleVersion', type: 'varchar', length: '14' },
                        { name: 'attemptedAt', type: 'timestamp' },
                    ],
                }),
                true,
            );
        }

        const report = await queryRunner.getTable(self.REPORT);
        if (report && !report.indices.some((index) => index.name === self.REPORT_INDEX)) {
            await queryRunner.createIndex(
                self.REPORT,
                new TableIndex({ name: self.REPORT_INDEX, columnNames: ['attemptedAt'] }),
            );
        }

        if (!(await queryRunner.hasTable(self.LEASE))) {
            await queryRunner.createTable(
                new Table({
                    name: self.LEASE,
                    columns: [
                        { name: 'id', type: 'varchar', length: '16', isPrimary: true },
                        { name: 'holder', type: 'varchar', length: '64', isNullable: true },
                        { name: 'expiresAt', type: 'timestamp', isNullable: true },
                        { name: 'nextSendAt', type: 'timestamp', isNullable: true },
                        { name: 'failures', type: 'int', default: 0 },
                        {
                            name: 'rejectedModuleVersion',
                            type: 'varchar',
                            length: '14',
                            isNullable: true,
                        },
                        { name: 'lastManualSendAt', type: 'timestamp', isNullable: true },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
    }

    /** Drops exactly the three tables `up()` created (with their index). */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const self = CreateEverInstanceAndStats1792300000000;
        for (const table of [self.LEASE, self.REPORT, self.INSTANCE]) {
            if (await queryRunner.hasTable(table)) {
                // `dropTable(name, ifExists, dropForeignKeys, dropIndices)`.
                await queryRunner.dropTable(table, true, true, true);
            }
        }
    }
}
