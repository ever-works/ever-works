import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * EW-693 — Dynamic plugin distribution. Phase 2 (T8).
 *
 * Adds five additive, nullable/defaulted columns to the `plugins`
 * table so a deployment can persist where a plugin came from and where
 * it sits in the install lifecycle:
 *
 * - `source`           varchar default 'bundled' — origin (bundled vs registry).
 * - `registrySpec`     varchar nullable        — exact npm spec installed.
 * - `installedVersion` varchar nullable        — version on disk now.
 * - `integrity`        varchar nullable        — sha512 used to verify install.
 * - `installState`     varchar default 'available' — install lifecycle.
 * - `installError`     text    nullable        — last install error reason.
 *
 * Backfill: existing rows pre-date dynamic mode and are all bundled +
 * already installed at boot, so the migration explicitly sets
 * `source = 'bundled'` and `installState = 'installed'` on every
 * existing row (the column defaults handle fresh rows after that).
 *
 * Forward-only / NO DROP: this migration is additive. There is no
 * `down()` data destruction — we follow NN #16 / Principle V. If the
 * change ever needs to be reverted, do it via a follow-up migration
 * that adds compensating columns rather than dropping these.
 */
export class AddPluginDistributionColumns1780200000000 implements MigrationInterface {
    name = 'AddPluginDistributionColumns1780200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumns('plugins', [
            new TableColumn({
                name: 'source',
                type: 'varchar',
                default: "'bundled'",
            }),
            new TableColumn({
                name: 'registrySpec',
                type: 'varchar',
                isNullable: true,
            }),
            new TableColumn({
                name: 'installedVersion',
                type: 'varchar',
                isNullable: true,
            }),
            new TableColumn({
                name: 'integrity',
                type: 'varchar',
                isNullable: true,
            }),
            new TableColumn({
                name: 'installState',
                type: 'varchar',
                default: "'available'",
            }),
            new TableColumn({
                name: 'installError',
                type: 'text',
                isNullable: true,
            }),
        ]);

        // Backfill: every existing row pre-dates dynamic mode, so it
        // is bundled-in-image and effectively `installed` already. Set
        // both columns explicitly — the column default 'available'
        // only applies to fresh rows.
        await queryRunner.query(
            `UPDATE "plugins" SET "source" = 'bundled', "installState" = 'installed'`,
        );
    }

    public async down(): Promise<void> {
        // Forward-only (NN #16 / Principle V). Reverting these columns
        // would lose the install-lifecycle history; if reversion ever
        // becomes necessary, ship a compensating migration that adds
        // "deprecated_*" columns and stops writing to the originals.
    }
}
