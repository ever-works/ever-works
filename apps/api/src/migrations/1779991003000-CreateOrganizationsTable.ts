import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * EW-653 (Tenants & Organizations Phase 1) — creates the
 * `organizations` table behind the new `Organization` entity.
 *
 * Mirrors the entity 1:1:
 *   - id (uuid, pk),
 *   - tenantId (uuid, FK → tenants.id, ON DELETE CASCADE),
 *   - slug (varchar 64, unique globally),
 *   - legalName (varchar 200, nullable),
 *   - displayName (varchar 200),
 *   - countryCode (varchar 2, nullable),
 *   - registrationProvider (varchar 32, nullable — open string for
 *     future providers; manual / stripe-atlas today),
 *   - registrationStatus (varchar 16, default 'draft' — draft /
 *     pending / registered),
 *   - linkedWorkId (uuid, nullable — no FK to works yet because Work
 *     already has organizationId going the other direction and a real
 *     FK both ways risks a circular constraint at migration time),
 *   - createdAt, updatedAt (timestamps).
 *
 * Indexes:
 *   - UNIQUE on `slug` (matches the entity decorator).
 *   - `idx_organizations_tenant_created` on `(tenantId, createdAt)`
 *     for the WorkspaceSwitcher list query (Phase 8 / EW-660).
 *
 * **No rows are written.** Insertions happen via
 * `OrganizationService.createOrganization` (Phase 6) and the Stripe
 * Atlas completion handler (Phase 10).
 *
 * Note on cross-Org slug collisions vs `users.slug` and `tenants.slug`:
 * those are NOT enforced at the DB level (different tables can't share
 * a single UNIQUE constraint without a materialized view or trigger).
 * The application-layer `UsernameAllocatorService.allocateSlug`
 * (EW-652) guarantees no cross-table collision at write time. This is
 * a deliberate trade — the DB enforces per-table uniqueness, the app
 * enforces cross-table uniqueness.
 *
 * Forward-only, additive, idempotent.
 */
export class CreateOrganizationsTable1779991003000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('organizations'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'organizations',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'tenantId', type: 'uuid', isNullable: false },
                        { name: 'slug', type: 'varchar', length: '64', isNullable: false },
                        {
                            name: 'legalName',
                            type: 'varchar',
                            length: '200',
                            isNullable: true,
                        },
                        {
                            name: 'displayName',
                            type: 'varchar',
                            length: '200',
                            isNullable: false,
                        },
                        { name: 'countryCode', type: 'varchar', length: '2', isNullable: true },
                        {
                            name: 'registrationProvider',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        {
                            name: 'registrationStatus',
                            type: 'varchar',
                            length: '16',
                            isNullable: false,
                            default: "'draft'",
                        },
                        { name: 'linkedWorkId', type: 'uuid', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                        {
                            name: 'updatedAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                    foreignKeys: [
                        {
                            name: 'fk_organizations_tenant',
                            columnNames: ['tenantId'],
                            referencedTableName: 'tenants',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                    ],
                }),
                true,
            );
        }

        const organizations = await queryRunner.getTable('organizations');

        const hasSlugIndex = organizations?.indices.some(
            (i) => i.name === 'idx_organizations_slug_unique',
        );
        if (!hasSlugIndex) {
            await queryRunner.createIndex(
                'organizations',
                new TableIndex({
                    name: 'idx_organizations_slug_unique',
                    columnNames: ['slug'],
                    isUnique: true,
                }),
            );
        }

        const hasTenantIndex = organizations?.indices.some(
            (i) => i.name === 'idx_organizations_tenant_created',
        );
        if (!hasTenantIndex) {
            await queryRunner.createIndex(
                'organizations',
                new TableIndex({
                    name: 'idx_organizations_tenant_created',
                    columnNames: ['tenantId', 'createdAt'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const organizations = await queryRunner.getTable('organizations');
        if (organizations?.indices.some((i) => i.name === 'idx_organizations_tenant_created')) {
            await queryRunner.dropIndex('organizations', 'idx_organizations_tenant_created');
        }
        if (organizations?.indices.some((i) => i.name === 'idx_organizations_slug_unique')) {
            await queryRunner.dropIndex('organizations', 'idx_organizations_slug_unique');
        }
        if (await queryRunner.hasTable('organizations')) {
            await queryRunner.dropTable('organizations');
        }
    }
}
