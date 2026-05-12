import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds the four `platformSync*` columns to the `works` table for the EW-120
 * Activity Feed feature.
 *
 * Forward-only, additive. All four columns are nullable or have a safe
 * default so existing rows remain valid with no backfill required.
 *
 * - `platformSyncSecretEncrypted`: AES-256-GCM-encrypted per-Work shared
 *   secret used by the platform aggregator to authenticate against the
 *   deployed directory site's `/api/platform/activity-feed` endpoint.
 *   NULL until the next deploy lazily provisions it.
 * - `platformSyncEnabled`: owner-controlled toggle, default `true`.
 * - `platformSyncLastSuccessAt` / `platformSyncLastError`: observability for
 *   the degraded-mode banner shown in the Activity Feed UI.
 */
export class AddWorkPlatformSync1778615285640 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumns('works', [
            new TableColumn({
                name: 'platformSyncSecretEncrypted',
                type: 'text',
                isNullable: true,
            }),
            new TableColumn({
                name: 'platformSyncEnabled',
                type: 'boolean',
                isNullable: false,
                default: true,
            }),
            new TableColumn({
                name: 'platformSyncLastSuccessAt',
                type: 'bigint',
                isNullable: true,
            }),
            new TableColumn({
                name: 'platformSyncLastError',
                type: 'varchar',
                isNullable: true,
            }),
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumns('works', [
            'platformSyncLastError',
            'platformSyncLastSuccessAt',
            'platformSyncEnabled',
            'platformSyncSecretEncrypted',
        ]);
    }
}
