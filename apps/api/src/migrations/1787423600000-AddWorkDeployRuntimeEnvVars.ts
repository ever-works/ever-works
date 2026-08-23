import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `works.deployRuntimeEnvEncrypted` — an AES-256-GCM-encrypted JSON map
 * of the operator-managed, allow-listed per-Work runtime env (today: the
 * Stripe payment keys the directory template reads, see
 * `WORK_RUNTIME_ENV_ALLOWED_KEYS` in
 * `packages/agent/src/services/work-runtime-env.constants.ts`).
 *
 * `DeployService` merges the map into the `${slug}-runtime-env` k8s Secret on
 * server-side deploys and pushes each key as a GitHub Actions repo secret on
 * workflow deploys. Encrypted at rest with `PLATFORM_ENCRYPTION_KEY`, exactly
 * like the sibling `deployDatabaseUrlEncrypted` column.
 *
 * Nullable, no backfill (NULL = nothing configured). Forward-only and
 * idempotent (`hasColumn` guard) — mirrors `AddWorkDeployRuntimeEnv` /
 * `AddWorkDeployDatabaseMode`.
 */
export class AddWorkDeployRuntimeEnvVars1787423600000 implements MigrationInterface {
    name = 'AddWorkDeployRuntimeEnvVars1787423600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'deployRuntimeEnvEncrypted'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'deployRuntimeEnvEncrypted',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('works', 'deployRuntimeEnvEncrypted')) {
            await queryRunner.dropColumn('works', 'deployRuntimeEnvEncrypted');
        }
    }
}
