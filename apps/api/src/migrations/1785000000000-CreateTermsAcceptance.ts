import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * The `terms_acceptance` table.
 *
 * ## Why
 *
 * The signup form rendered `<input id="terms" type="checkbox" required>` —
 * uncontrolled, absent from `formData`, never posted, never stored. HTML5
 * `required` blocked the submit button and that was the entire mechanism. The
 * user saw a checkbox; the database had nothing, and there was no way to answer
 * *which version of the Terms did this customer accept, and what did it say?*
 *
 * ## Additive
 *
 * This creates one new table. No existing table gains, loses or changes a
 * column. There is nothing to backfill: acceptance was never recorded anywhere,
 * so accounts created before this deploy correctly have no row.
 *
 * ## Shape
 *
 * Columns mirror `termsAcceptanceSchema` from `terms-acceptance/better-auth`,
 * because Better Auth writes these rows through its own database layer (raw SQL
 * over the pool extracted from TypeORM) rather than through the repository. Get
 * a column name wrong here and the INSERT fails at runtime, not at build.
 *
 * `userId` deliberately carries **no** foreign key: deleting a user must not
 * silently destroy the proof that they once agreed to something. Every other
 * user-owned table here cascades; this one does not, and that asymmetry is the
 * point.
 *
 * The unique index on `(userId, documentId, version)` is what makes recording
 * idempotent — a double-submitted signup form returns the existing row rather
 * than writing a second one, so two pieces of evidence can never disagree about
 * the time.
 *
 * Built with TypeORM's portable `Table` API rather than raw SQL because CI and
 * the e2e stack run better-sqlite3 while production runs Postgres.
 *
 * Forward-only with an idempotent guard (house pattern, mirrors
 * 1784820000000-CreateWorkflows).
 */
export class CreateTermsAcceptance1785000000000 implements MigrationInterface {
    name = 'CreateTermsAcceptance1785000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('terms_acceptance')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'terms_acceptance',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    // Identifier minted by `terms-acceptance` (`ta_…`), distinct
                    // from the row id Better Auth generates.
                    { name: 'recordId', type: 'varchar', length: '128' },
                    { name: 'userId', type: 'varchar', length: '255' },
                    { name: 'tenantId', type: 'varchar', length: '255', isNullable: true },
                    // `<document>:<product>`, e.g. `tos:ever-works`.
                    { name: 'documentId', type: 'varchar', length: '255' },
                    { name: 'version', type: 'varchar', length: '64' },
                    // sha256 of the exact document source, from @ever-co/legal.
                    // This is what makes the row evidence and not an assertion.
                    { name: 'sha256', type: 'varchar', length: '64' },
                    { name: 'acceptedAt', type: 'timestamp' },
                    { name: 'locale', type: 'varchar', length: '35' },
                    // Salted digest of the client IP. Never the address itself.
                    { name: 'ipHash', type: 'varchar', length: '64', isNullable: true },
                    { name: 'userAgent', type: 'varchar', length: '512', isNullable: true },
                    { name: 'method', type: 'varchar', length: '64' },
                    { name: 'metadata', type: 'text', isNullable: true },
                    // sha256 over the canonical form of every other field.
                    { name: 'fingerprint', type: 'varchar', length: '64' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'terms_acceptance',
            new TableIndex({
                name: 'idx_terms_acceptance_record',
                columnNames: ['recordId'],
                isUnique: true,
            }),
        );
        // Makes a replayed submission a no-op instead of a second row.
        await queryRunner.createIndex(
            'terms_acceptance',
            new TableIndex({
                name: 'idx_terms_acceptance_unique',
                columnNames: ['userId', 'documentId', 'version'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'terms_acceptance',
            new TableIndex({
                name: 'idx_terms_acceptance_user',
                columnNames: ['userId', 'documentId'],
            }),
        );
        // "Show me everyone still on ToS 1.x" — the query an auditor asks.
        await queryRunner.createIndex(
            'terms_acceptance',
            new TableIndex({
                name: 'idx_terms_acceptance_document',
                columnNames: ['documentId', 'version'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverting DESTROYS EVIDENCE — this is not an ordinary additive-column
        // rollback. Dropping this table deletes the proof of who agreed to what,
        // which is the one thing it exists to hold. In production prefer to
        // leave the table in place and stop writing to it.
        if (await queryRunner.hasTable('terms_acceptance')) {
            await queryRunner.dropTable('terms_acceptance');
        }
    }
}
