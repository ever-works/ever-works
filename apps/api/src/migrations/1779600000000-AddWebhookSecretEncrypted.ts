import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `works.webhookSecretEncrypted` for the per-Work persistent
 * `WEBHOOK_SECRET` baked into the deployed minimal-template site at build
 * time.
 *
 * The deployed site's `@ever-works/astro-integration` reads
 * `process.env.WEBHOOK_SECRET` and registers an authenticated `/api/webhook`
 * endpoint that verifies incoming GitHub push notifications via
 * X-Hub-Signature-256. Rotating the secret on every deploy would silently
 * break verification until the GitHub-side webhook registration was also
 * updated. Persisting it per-Work — same pattern as `platformSyncSecretEncrypted`
 * — keeps the secret stable across redeploys unless explicitly rotated via
 * `WebhookSecretService.rotate()`.
 *
 * Forward-only, additive. The column is nullable; existing rows stay NULL
 * until their next deploy lazily provisions a value via
 * `WebhookSecretService.getOrGenerate`. No backfill required.
 */
export class AddWebhookSecretEncrypted1779600000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'webhookSecretEncrypted'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'webhookSecretEncrypted',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('works', 'webhookSecretEncrypted')) {
            await queryRunner.dropColumn('works', 'webhookSecretEncrypted');
        }
    }
}
