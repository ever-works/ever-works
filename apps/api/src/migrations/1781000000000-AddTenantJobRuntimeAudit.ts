import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * EW-742 P1 (T12) — creates the `tenant_job_runtime_audit` append-only
 * audit log. Sibling to migration `1780900000000-AddTenantJobRuntimeConfig`;
 * every mutation to a `tenant_job_runtime_config` row writes one
 * `tenant_job_runtime_audit` row with the before/after state, the actor
 * (operator user vs system) and the credential version associated with
 * the action.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md` §FR-13](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan reference: [`plan.md` §3 + §10 P5 (T35)](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 * Decision record: [ADR-017](../../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
 *
 * Columns mirror `TenantJobRuntimeAudit` entity in
 * `packages/agent/src/entities/tenant-job-runtime-audit.entity.ts`.
 *
 * Forward-only, idempotent (`hasTable` guard). `before`/`after` are
 * declared `text` at the SQL level for dialect portability (the test
 * driver is better-sqlite3, which lacks `jsonb`); the entity column type
 * is `simple-json`, which round-trips via JSON.stringify/parse and works
 * equally well against text on either driver — same pattern as
 * `missions.guardrailsOverride` (migration 1779978001000) and
 * `webhook_deliveries.payload`.
 *
 * Secrets MUST be redacted by the writing service BEFORE serialising into
 * `before`/`after` — this migration only allocates the storage; it does
 * not enforce redaction. The writing service contract is documented on
 * `TenantJobRuntimeAudit` in the entity file.
 *
 * Compound index `(tenantId, occurredAt)` matches the most common ops
 * query ("give me this tenant's job-runtime history newest first"). No
 * separate index on `actorUserId` — operator-attribution queries are
 * tenant-scoped, so they ride the compound index.
 */
export class AddTenantJobRuntimeAudit1781000000000 implements MigrationInterface {
    name = 'AddTenantJobRuntimeAudit1781000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tenant_job_runtime_audit')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'tenant_job_runtime_audit',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'tenantId', type: 'uuid' },
                    { name: 'actorUserId', type: 'uuid', isNullable: true },
                    { name: 'action', type: 'varchar', length: '64' },
                    {
                        // `simple-json` on the entity stores as text on
                        // SQLite and as text/jsonb on Postgres depending
                        // on driver defaults. Use `text` here so the
                        // migration is dialect-portable (the test driver
                        // is better-sqlite3, which lacks `jsonb`) — same
                        // pattern as `missions.guardrailsOverride`
                        // (migration 1779978001000).
                        name: 'before',
                        type: 'text',
                        isNullable: true,
                    },
                    { name: 'after', type: 'text', isNullable: true },
                    { name: 'credentialVersion', type: 'int', isNullable: true },
                    {
                        name: 'occurredAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'tenant_job_runtime_audit',
            new TableForeignKey({
                name: 'fk_tenant_job_runtime_audit_tenant',
                columnNames: ['tenantId'],
                referencedTableName: 'tenants',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        // actorUserId is informational only (audit rows MUST survive user
        // deletion so the trail remains complete). ON DELETE SET NULL
        // preserves the row with a null actor when the originating user
        // is purged.
        await queryRunner.createForeignKey(
            'tenant_job_runtime_audit',
            new TableForeignKey({
                name: 'fk_tenant_job_runtime_audit_actor',
                columnNames: ['actorUserId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );

        await queryRunner.createIndex(
            'tenant_job_runtime_audit',
            new TableIndex({
                name: 'idx_tenant_job_runtime_audit_tenant_occurred',
                columnNames: ['tenantId', 'occurredAt'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tenant_job_runtime_audit')) {
            await queryRunner.dropTable('tenant_job_runtime_audit', true);
        }
    }
}
