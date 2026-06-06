import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * EW-693 — Dynamic plugin distribution. Phase 2 (T8).
 *
 * Creates `plugin_allowlist`: the admin-managed list of non-first-party
 * npm packages permitted for runtime install. First-party `@ever-works/*`
 * is implicitly allowed and is NOT stored here; everything else MUST
 * have an enabled row before the installer will fetch.
 *
 * Schema mirrors `PluginAllowlistEntity`:
 * - `id`           uuid PK (pgcrypto-style; runs after enabling extension).
 * - `packageName`  varchar unique (one row per npm package).
 * - `versionRange` varchar (semver range; pin or tolerated band).
 * - `integrity`    varchar nullable (optional sha512 pinning).
 * - `source`       varchar default 'npm' (npm | github-packages).
 * - `enabled`      boolean default true (toggle without delete).
 * - `createdAt`    timestamp default now().
 *
 * Forward-only, idempotent (`ifNotExists`). No `down()` drop — see
 * NN #16 / Principle V. If the table ever needs removing, ship a
 * compensating migration; do not drop user data.
 */
export class CreatePluginAllowlist1780200001000 implements MigrationInterface {
    name = 'CreatePluginAllowlist1780200001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'plugin_allowlist',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'packageName', type: 'varchar' },
                    { name: 'versionRange', type: 'varchar' },
                    { name: 'integrity', type: 'varchar', isNullable: true },
                    { name: 'source', type: 'varchar', default: "'npm'" },
                    { name: 'enabled', type: 'boolean', default: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // Unique on `packageName` — at most one allowlist row per package.
        // Updates re-pin existing rows rather than create duplicates.
        await queryRunner.createIndex(
            'plugin_allowlist',
            new TableIndex({
                name: 'uq_plugin_allowlist_package',
                columnNames: ['packageName'],
                isUnique: true,
            }),
        );
    }

    public async down(): Promise<void> {
        // Forward-only. See the `up()` doc comment.
    }
}
