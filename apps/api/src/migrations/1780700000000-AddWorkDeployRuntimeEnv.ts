import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds the per-Work encrypted runtime-env columns used by the k8s deploy
 * feature to inject `AUTH_SECRET` / `COOKIE_SECRET` / `DATABASE_URL` into a
 * deployed site's container.
 *
 * Vercel supplied these from project env + the Neon Marketplace integration;
 * the k8s deploy path had no equivalent, so a freshly-built directory site
 * 500'd at runtime (`[auth] AUTH_SECRET must be set in production`). The
 * deploy feature now generates + persists the auth/cookie secrets (stable
 * across redeploys) and stores the per-Work database URL, all AES-256-GCM
 * encrypted-at-rest with `PLATFORM_ENCRYPTION_KEY` — mirroring the existing
 * `webhookSecretEncrypted` / `platformSyncSecretEncrypted` columns.
 *
 * Forward-only and idempotent (`hasColumn` guard). Columns are nullable;
 * no backfill — values are lazily provisioned on the next k8s deploy (or
 * seeded out-of-band for the existing Vercel→k8s migration Works).
 */
export class AddWorkDeployRuntimeEnv1780700000000 implements MigrationInterface {
    name = 'AddWorkDeployRuntimeEnv1780700000000';

    private readonly columns = [
        'deployAuthSecretEncrypted',
        'deployCookieSecretEncrypted',
        'deployDatabaseUrlEncrypted',
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const name of this.columns) {
            if (!(await queryRunner.hasColumn('works', name))) {
                await queryRunner.addColumn(
                    'works',
                    new TableColumn({ name, type: 'text', isNullable: true }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const name of this.columns) {
            if (await queryRunner.hasColumn('works', name)) {
                await queryRunner.dropColumn('works', name);
            }
        }
    }
}
