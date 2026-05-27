import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * EW-653 (Tenants & Organizations Phase 1) — creates the `tenants`
 * table behind the new `Tenant` entity.
 *
 * Mirrors the entity 1:1:
 *   - id (uuid, pk),
 *   - ownerUserId (uuid, unique, FK → users.id, ON DELETE CASCADE),
 *   - slug (varchar 64, unique),
 *   - displayName (varchar 200),
 *   - createdAt, updatedAt (timestamps).
 *
 * The unique constraint on `ownerUserId` enforces the v1 invariant
 * "1 User : 1 Tenant". Dropping it later (if v1.1 wants
 * multi-tenant-per-user) is additive and reversible — see
 * [spec.md §7 v1.1 + open decisions](../../../../docs/specs/features/tenants-and-organizations/spec.md#7-open-decisions--out-of-scope-v11).
 *
 * **No rows are written** by this migration. The lazy-create flow in
 * Phase 6 (EW-658) inserts the first Tenant row when a user creates
 * their first Organization.
 *
 * Forward-only, additive, idempotent (gates on `hasTable`).
 */
export class CreateTenantsTable1779991002000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tenants'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'tenants',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'ownerUserId', type: 'uuid', isNullable: false },
                        { name: 'slug', type: 'varchar', length: '64', isNullable: false },
                        {
                            name: 'displayName',
                            type: 'varchar',
                            length: '200',
                            isNullable: false,
                        },
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
                            name: 'fk_tenants_owner_user',
                            columnNames: ['ownerUserId'],
                            referencedTableName: 'users',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                    ],
                }),
                true,
            );
        }

        const tenants = await queryRunner.getTable('tenants');

        // Unique index on ownerUserId — enforces 1:1 User:Tenant in v1.
        const hasOwnerIndex = tenants?.indices.some(
            (i) => i.name === 'idx_tenants_owner_user_unique',
        );
        if (!hasOwnerIndex) {
            await queryRunner.createIndex(
                'tenants',
                new TableIndex({
                    name: 'idx_tenants_owner_user_unique',
                    columnNames: ['ownerUserId'],
                    isUnique: true,
                }),
            );
        }

        // Unique index on slug — required for the slug routing layer
        // (Phase 7 / EW-659).
        const hasSlugIndex = tenants?.indices.some((i) => i.name === 'idx_tenants_slug_unique');
        if (!hasSlugIndex) {
            await queryRunner.createIndex(
                'tenants',
                new TableIndex({
                    name: 'idx_tenants_slug_unique',
                    columnNames: ['slug'],
                    isUnique: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tenants = await queryRunner.getTable('tenants');
        if (tenants?.indices.some((i) => i.name === 'idx_tenants_slug_unique')) {
            await queryRunner.dropIndex('tenants', 'idx_tenants_slug_unique');
        }
        if (tenants?.indices.some((i) => i.name === 'idx_tenants_owner_user_unique')) {
            await queryRunner.dropIndex('tenants', 'idx_tenants_owner_user_unique');
        }
        if (await queryRunner.hasTable('tenants')) {
            await queryRunner.dropTable('tenants');
        }
    }
}
