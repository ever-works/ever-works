import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds the dual-mode Activity Feed sync surface to the `works` table
 * (EW-120).
 *
 * - `activitySyncMode` — per-Work transport choice (`pull` | `push` |
 *   `disabled`). Default `pull` so existing rows match the historic
 *   architecture; site authors can flip via `works.yml`.
 * - `platformSyncSecretEncrypted` — AES-256-GCM-encrypted per-Work HMAC
 *   secret used by the pull transport to sign outbound requests to the
 *   deployed directory site. NULL until the next deploy provisions it
 *   lazily.
 * - `platformSyncLastSuccessAt` / `platformSyncLastErrorAt` /
 *   `platformSyncLastErrorMessage` — observability for the pull
 *   transport, drives the degraded banner on the Activity Feed tab.
 *
 * Forward-only, additive. All non-mode columns are nullable; the mode
 * column has a safe default. No backfill required.
 *
 * The `@TimestampColumn` decorator on the entity stores Dates as
 * bigint ms — that's the canonical pattern across this codebase (see
 * Work.lastGeneratedAt etc.) for portability between SQLite (no
 * timestamptz) and Postgres.
 */
export class AddActivityFeedSync1778746463309 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumns('works', [
            new TableColumn({
                name: 'activitySyncMode',
                type: 'varchar',
                length: '16',
                isNullable: false,
                default: "'pull'",
            }),
            new TableColumn({
                name: 'platformSyncSecretEncrypted',
                type: 'text',
                isNullable: true,
            }),
            new TableColumn({
                name: 'platformSyncLastSuccessAt',
                type: 'bigint',
                isNullable: true,
            }),
            new TableColumn({
                name: 'platformSyncLastErrorAt',
                type: 'bigint',
                isNullable: true,
            }),
            new TableColumn({
                name: 'platformSyncLastErrorMessage',
                type: 'text',
                isNullable: true,
            }),
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumns('works', [
            'platformSyncLastErrorMessage',
            'platformSyncLastErrorAt',
            'platformSyncLastSuccessAt',
            'platformSyncSecretEncrypted',
            'activitySyncMode',
        ]);
    }
}
