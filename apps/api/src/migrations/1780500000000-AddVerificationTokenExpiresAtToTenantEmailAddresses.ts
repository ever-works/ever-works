import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * EW-711 #44 — Email address verification tokens had no expiry: a leaked
 * confirmation link could verify a `tenant_email_addresses` row forever.
 *
 * Adds the nullable `verificationTokenExpiresAt` timestamp that
 * `EmailService.createAddress` now stamps (24h TTL) alongside the token and
 * `EmailService.confirmVerification` checks before flipping `verified`.
 *
 * NULL semantics: no pending token, or a legacy token issued before this
 * column existed — legacy tokens stay confirmable (no backfill) so in-flight
 * verification emails are not invalidated by the deploy.
 *
 * Additive + idempotent (column-existence guard, mirroring the
 * AddAgentScopeTargetIdForDurableSlugCas pattern) so a re-run at pod boot
 * (`migrationsRun: true`) cannot CrashLoopBackOff the API. Cross-dialect:
 * `timestamp` matches the entity's `@PortableDateColumn` (`type: Date`) on
 * Postgres and resolves via type affinity on the better-sqlite3 test driver,
 * same as the existing `disabledAt` column on this table.
 */
export class AddVerificationTokenExpiresAtToTenantEmailAddresses1780500000000 implements MigrationInterface {
    name = 'AddVerificationTokenExpiresAtToTenantEmailAddresses1780500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('tenant_email_addresses');
        const hasColumn = table?.columns.some((c) => c.name === 'verificationTokenExpiresAt');
        if (!hasColumn) {
            await queryRunner.addColumn(
                'tenant_email_addresses',
                new TableColumn({
                    name: 'verificationTokenExpiresAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('tenant_email_addresses');
        const hasColumn = table?.columns.some((c) => c.name === 'verificationTokenExpiresAt');
        if (hasColumn) {
            await queryRunner.dropColumn('tenant_email_addresses', 'verificationTokenExpiresAt');
        }
    }
}
