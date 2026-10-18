import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Fleet hub (FL-01) — the owner can star a computer.
 *
 *  - `fleet_nodes.isFavorite` (boolean, NOT NULL, default false) — favourites
 *    sort first on the Fleet hub's Overview and Computers tab. Every existing
 *    row lands `false`: nobody has starred anything yet.
 *
 * One flag on the Node row (CONTRACTS §4.1) because a Node has exactly one
 * owner (README D15) and only the owner may set it. If Organization members
 * ever get favourites of their own it becomes a per-user table; this column
 * then stays as the owner's.
 *
 * Forward-only with a per-step guard so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddFleetNodeFavorite1796010100000 implements MigrationInterface {
    name = 'AddFleetNodeFavorite1796010100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('isFavorite')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({
                    name: 'isFavorite',
                    type: 'boolean',
                    isNullable: false,
                    default: false,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('isFavorite')) {
            await queryRunner.dropColumn('fleet_nodes', 'isFavorite');
        }
    }
}
