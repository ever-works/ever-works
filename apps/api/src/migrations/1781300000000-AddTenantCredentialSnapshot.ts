import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * EW-742 P1 T11 follow-up — creates the `tenant_credential_snapshot`
 * table that backs the per-version credential history for the tenant
 * overlay. Required by the graceful-drain semantic from
 * [ADR-017 §3 Q4](../../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md#3-credential-rotation--graceful-drain-locked-q4-do-not-reopen):
 * `CredentialVersionService.resolveSnapshot(tenantId, N)` MUST keep
 * returning the version-N bag even after the tenant rotates to N+1, so
 * an in-flight run pinned at N can still bind to its original credentials.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md` FR-5](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §3](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#3-data-model)
 * Entity: `packages/agent/src/entities/tenant-credential-snapshot.entity.ts`
 *
 * **Schema:**
 *   - Synthetic PK `id` (`uuid`) so future audit / run-history rows can
 *     FK to a specific snapshot row.
 *   - UNIQUE index on `(tenantId, providerId, credentialVersion)` —
 *     the natural key. Re-inserting the same tuple is the caller's
 *     idempotency signal (the service swallows the conflict).
 *   - Secondary index on `tenantId` for the "list every snapshot for
 *     this tenant" lookup (drain reconciliation + operator dashboards).
 *   - `credentialsEncrypted` as `jsonb` — the bag is opaque to the DB
 *     and already-encrypted by the secret-store resolver layer. JSONB
 *     keeps future shape evolution migration-free.
 *   - `capturedAt` defaults to `CURRENT_TIMESTAMP`; rows are immutable
 *     (no `updatedAt`).
 *   - FK `tenantId` → `tenants.id` with `ON DELETE CASCADE` so removing
 *     a tenant takes the per-tenant snapshot history with it. Mirrors
 *     the same cascade choice used by `tenant_job_runtime_config` and
 *     `tenant_runtime_provider_allowlist`.
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1780900000000-AddTenantJobRuntimeConfig` and
 * `1781100000000-AddTenantRuntimeProviderAllowlist`.
 */
export class AddTenantCredentialSnapshot1781300000000 implements MigrationInterface {
    name = 'AddTenantCredentialSnapshot1781300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tenant_credential_snapshot')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'tenant_credential_snapshot',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    {
                        name: 'tenantId',
                        type: 'uuid',
                    },
                    {
                        name: 'providerId',
                        type: 'varchar',
                        length: '64',
                    },
                    {
                        name: 'credentialVersion',
                        type: 'integer',
                    },
                    {
                        name: 'credentialsEncrypted',
                        type: 'jsonb',
                    },
                    {
                        name: 'capturedAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        // Secondary index for the "list every snapshot for tenant X"
        // lookup (drain reconciliation + operator dashboards). The
        // composite UNIQUE index below also covers tenant-scoped
        // lookups when providerId is also constrained, but a
        // tenant-only sweep (delete on tenant offboard, ops audit)
        // benefits from a dedicated single-column index.
        await queryRunner.createIndex(
            'tenant_credential_snapshot',
            new TableIndex({
                name: 'idx_tenant_credential_snapshot_tenant',
                columnNames: ['tenantId'],
            }),
        );

        // Natural key uniqueness — the service translates a PK-conflict
        // on this index into a no-op (idempotent captureSnapshot).
        await queryRunner.createIndex(
            'tenant_credential_snapshot',
            new TableIndex({
                name: 'uq_tenant_credential_snapshot_tenant_provider_version',
                columnNames: ['tenantId', 'providerId', 'credentialVersion'],
                isUnique: true,
            }),
        );

        // Remove the snapshot history when the owning tenant is purged.
        // Same cascade choice as `tenant_job_runtime_config` +
        // `tenant_runtime_provider_allowlist` — the snapshot bag is
        // meaningless without the tenant it belonged to.
        await queryRunner.createForeignKey(
            'tenant_credential_snapshot',
            new TableForeignKey({
                name: 'fk_tenant_credential_snapshot_tenant',
                columnNames: ['tenantId'],
                referencedTableName: 'tenants',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tenant_credential_snapshot')) {
            await queryRunner.dropTable('tenant_credential_snapshot', true);
        }
    }
}
