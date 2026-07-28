import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fleet admin surface — the two `fleet_nodes` columns the credential
 * rotation and admin-editable capability tags need.
 *
 *  - `credentialIssuedAt` — when the CURRENT credential was minted.
 *                           Enrollment-token expiry is measured from
 *                           here instead of `createdAt`, because
 *                           rotation mints a fresh token on an EXISTING
 *                           row: judging it by the row's creation date
 *                           would make every rotated token expired on
 *                           arrival. NULL on pre-existing rows, and the
 *                           service falls back to `createdAt` for those,
 *                           so nothing about the shipped enroll flow
 *                           changes.
 *  - `capabilitiesPinned` — true once an operator hand-edited the tag
 *                           set. While pinned, a heartbeat no longer
 *                           overwrites `capabilities`, so an admin edit
 *                           is not silently reverted by the machine on
 *                           its next beat. Defaults to false = today's
 *                           behaviour (the node owns its tags).
 *
 * Forward-only with per-step guards (house pattern, mirrors
 * `1784400000000-AddRunAttentionColumns`). No new index: every read of
 * these columns is already narrowed by `idx_fleet_nodes_user` or by an
 * exact primary-key lookup.
 */
export class AddFleetNodeAdminColumns1784760000000 implements MigrationInterface {
    name = 'AddFleetNodeAdminColumns1784760000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('fleet_nodes');
        if (!table) return;

        if (!table.findColumnByName('credentialIssuedAt')) {
            await queryRunner.query(
                `ALTER TABLE "fleet_nodes" ADD COLUMN "credentialIssuedAt" TIMESTAMP`,
            );
        }
        if (!table.findColumnByName('capabilitiesPinned')) {
            await queryRunner.query(
                `ALTER TABLE "fleet_nodes" ADD COLUMN "capabilitiesPinned" boolean NOT NULL DEFAULT false`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('fleet_nodes');
        if (!table) return;
        for (const col of ['capabilitiesPinned', 'credentialIssuedAt']) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "fleet_nodes" DROP COLUMN "${col}"`);
            }
        }
    }
}
