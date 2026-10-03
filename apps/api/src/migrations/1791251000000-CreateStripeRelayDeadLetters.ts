import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Dead letters for the shared Stripe webhook relay (audit CC05-06).
 *
 * The relay used to answer Stripe `200` for every event it could not deliver
 * to a directory and keep only a log line, so a paid sponsor event lost to a
 * missing ingress rule, a WAF challenge or an unprovisioned secret was lost
 * for good. This table records each such event once, keyed by the Stripe
 * event id, with the verbatim payload so an operator can replay it.
 *
 * No foreign keys on purpose: `workId` is whatever the event named, and an
 * unknown Work is one of the failures this table exists to record.
 *
 * Additive and idempotent (`hasTable` guard). `down` keeps the rows: they are
 * the audit trail of paid events that went undelivered, and dropping them
 * would destroy the only record some of them have.
 */
export class CreateStripeRelayDeadLetters1791251000000 implements MigrationInterface {
    name = 'CreateStripeRelayDeadLetters1791251000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('stripe_relay_dead_letters')) return;

        await queryRunner.createTable(
            new Table({
                name: 'stripe_relay_dead_letters',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'eventId', type: 'varchar', length: '255' },
                    { name: 'eventType', type: 'varchar', length: '100' },
                    { name: 'workId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'livemode', type: 'boolean', default: false },
                    { name: 'disposition', type: 'varchar', length: '16' },
                    { name: 'reason', type: 'varchar', length: '64' },
                    { name: 'siteStatus', type: 'int', isNullable: true },
                    { name: 'attempts', type: 'int', default: 1 },
                    { name: 'status', type: 'varchar', length: '16', default: "'open'" },
                    { name: 'resolution', type: 'varchar', length: '32', isNullable: true },
                    { name: 'payload', type: 'text' },
                    { name: 'firstFailedAt', type: 'timestamp' },
                    { name: 'lastFailedAt', type: 'timestamp' },
                    { name: 'resolvedAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );
        await queryRunner.createIndex(
            'stripe_relay_dead_letters',
            new TableIndex({
                name: 'idx_stripe_relay_dead_letters_event',
                columnNames: ['eventId'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'stripe_relay_dead_letters',
            new TableIndex({
                name: 'idx_stripe_relay_dead_letters_status_failed',
                columnNames: ['status', 'lastFailedAt'],
            }),
        );
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Undelivered paid events are retained on purpose; see the class docblock.
    }
}
