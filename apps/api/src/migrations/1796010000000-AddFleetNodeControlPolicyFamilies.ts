import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Fleet hub (FL-01) — a Node's control policy becomes a map per action family.
 *
 * AW-11 gave a Node ONE value, `controlPolicy` (`owner · org-admins ·
 * org-members`): who may take control of a live view. The Fleet program asks
 * the same question for thirteen action families (CONTRACTS §2.1 — view,
 * sessions, desktop, logs, services, docker, processes, ports, files,
 * commands, schedules, checkouts, machines), so a Node can let its
 * Organization's admins start sessions while services stay the owner's.
 *
 *  - `fleet_nodes.controlPolicyFamilies` (text) — the entity's `simple-json`
 *    map from family to audience. Absent families take their default
 *    (`view: org-members`, every other family `owner`). NULL = no map stored.
 *
 * Deliberately a NEW column rather than a type change on `controlPolicy`: a
 * type change on a live column is not additive (Constitution V/X). The old
 * column keeps its type and meaning and is the `desktop` family's mirror —
 * read through when the map has no `desktop` entry, written back by every
 * write of that entry — so nothing that reads it today changes behaviour.
 * That read-through is also why there is no data backfill: every existing
 * row (map NULL) already reads `desktop` from `controlPolicy`.
 *
 * Forward-only with a per-step guard so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddFleetNodeControlPolicyFamilies1796010000000 implements MigrationInterface {
    name = 'AddFleetNodeControlPolicyFamilies1796010000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('controlPolicyFamilies')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({ name: 'controlPolicyFamilies', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('controlPolicyFamilies')) {
            await queryRunner.dropColumn('fleet_nodes', 'controlPolicyFamilies');
        }
    }
}
