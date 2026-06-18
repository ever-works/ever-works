import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

/**
 * EW-742 P1 (T10) — creates the `tenant_job_runtime_config` table that
 * stores the per-tenant overlay row used by the dispatcher-side
 * `TenantAwareRuntimeResolver` (P3 / T20) to route enqueues to a
 * tenant-specific provider + credential set.
 *
 * Background:
 *
 * EW-683 (instance-global job-runtime selection, ADR-015) made the
 * background-job runtime a deploy-wide selector via
 * `EVER_WORKS_JOB_RUNTIME`. EW-742 adds a per-tenant overlay on top of
 * that selector so one Ever Works instance can serve many tenants with
 * different runtimes / credentials without operators spinning up an
 * instance per tenant. Absence of a row is equivalent to `mode =
 * 'inherit'` — the tenant uses the instance-global selector + the
 * platform-default credentials and behaves byte-identically to
 * pre-overlay. Single-tenant self-hosters never write into this table.
 *
 * This migration is the STORAGE-TIER prerequisite for the cascade
 * resolver step (P1 / extends `PluginSettingsService.resolve()` with a
 * `tenant` tier between `user` and `global`, per
 * [`settings-system.md`](../../../../../docs/specs/architecture/settings-system.md)
 * §2). The grammar prerequisite (`x-scope: 'tenant'`) shipped earlier in
 * EW-742 P1.0 (PR #1335, commit 97c1fdf4).
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan §3 data model: [`plan.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#3-data-model)
 * Decision record: [ADR-017](../../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
 *
 * Columns mirror `TenantJobRuntimeConfig` entity in
 * `packages/agent/src/entities/tenant-job-runtime-config.entity.ts`.
 *
 * Mode + provider are `varchar` rather than Postgres enum types so future
 * modes / providers never need a type-altering migration — same
 * convention as `works.kind` (EW-665, migration 1779991010000).
 *
 * Forward-only and idempotent (`hasTable` guard). The partial index on
 * `(providerId) WHERE enabled = true` powers ops dashboards that want to
 * count active tenants per provider without scanning every soft-disabled
 * row.
 */
export class AddTenantJobRuntimeConfig1780900000000 implements MigrationInterface {
    name = 'AddTenantJobRuntimeConfig1780900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tenant_job_runtime_config')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'tenant_job_runtime_config',
                columns: [
                    {
                        name: 'tenantId',
                        type: 'uuid',
                        isPrimary: true,
                    },
                    { name: 'providerId', type: 'varchar', length: '64' },
                    { name: 'credentialsSecretRef', type: 'varchar', length: '128', isNullable: true },
                    { name: 'credentialVersion', type: 'int', default: 1 },
                    { name: 'mode', type: 'varchar', length: '16' },
                    { name: 'enabled', type: 'boolean', default: true },
                    { name: 'createdBy', type: 'uuid', isNullable: true },
                    {
                        name: 'createdAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'tenant_job_runtime_config',
            new TableForeignKey({
                name: 'fk_tenant_job_runtime_config_tenant',
                columnNames: ['tenantId'],
                referencedTableName: 'tenants',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        // createdBy → users.id is informational only (a row survives the
        // user being deleted; the audit log carries the actor identity
        // independently). ON DELETE SET NULL keeps the row queryable when
        // the originating user is purged.
        await queryRunner.createForeignKey(
            'tenant_job_runtime_config',
            new TableForeignKey({
                name: 'fk_tenant_job_runtime_config_user',
                columnNames: ['createdBy'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );

        // Partial index — Postgres-style `WHERE` clause. Powers ops
        // dashboards ("how many tenants are on `temporal` right now?")
        // without scanning soft-disabled rows. SQLite supports the same
        // partial-index syntax for the test/CLI path; other drivers fall
        // back gracefully (the application layer never depends on the
        // index being present, only on its selectivity).
        const driver = queryRunner.connection.options.type;
        if (driver === 'postgres') {
            await queryRunner.query(
                `CREATE INDEX IF NOT EXISTS "idx_tenant_job_runtime_config_provider_enabled" ` +
                    `ON "tenant_job_runtime_config" ("providerId") WHERE "enabled" = true`,
            );
        } else {
            try {
                await queryRunner.query(
                    `CREATE INDEX IF NOT EXISTS "idx_tenant_job_runtime_config_provider_enabled" ` +
                        `ON "tenant_job_runtime_config" ("providerId") WHERE "enabled" = true`,
                );
            } catch {
                // Best-effort on non-supporting drivers — the dashboard
                // query still works without the partial index, it just
                // scans more rows.
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX IF EXISTS "idx_tenant_job_runtime_config_provider_enabled"`,
        );
        if (await queryRunner.hasTable('tenant_job_runtime_config')) {
            await queryRunner.dropTable('tenant_job_runtime_config', true);
        }
    }
}
