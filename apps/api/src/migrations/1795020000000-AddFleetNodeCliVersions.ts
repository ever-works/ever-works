import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Node lifecycle (self-build slice AR) — the pinned model-CLI versions.
 *
 * The defect this closes: `fleet_nodes.cliVersion` (since `1786920000000`)
 * was probed by scanning PATH for the first of `claude` / `codex` /
 * `gemini` / `opencode`, NOT from the binary an `agent-task` actually
 * spawns. A machine that pins `EVER_WORKS_NODE_CLAUDE_PATH` at one build
 * and has another on PATH reported the wrong one, and a machine that drives
 * Codex reported whatever Claude happened to be installed. "Which CLI does
 * this PC run, per provider" had no answer anywhere on the platform — which
 * is exactly the question after one upstream release breaks a flag.
 *
 * One nullable column on `fleet_nodes`:
 *
 *  - `cliVersions` (text) — the entity's `simple-json` list of
 *    `"<provider> <version>"` entries, one per pinned provider. Same
 *    storage as `capabilities`, the other per-node string list.
 *
 * NO DEFAULT and NULL backfill: NULL is "this daemon never reported one",
 * which is the truth for every row that exists today. An empty-list
 * default would claim every enrolled machine has no CLI pinned.
 *
 * Portable DDL (`TableColumn`) because CI and the e2e stack run
 * better-sqlite3 while production runs Postgres. Guarded per step, so a
 * partially-applied database converges; `down()` goes through `dropColumn`
 * (never a raw `ALTER TABLE ... DROP COLUMN`, which sqlite only learned in
 * 3.35 and which desynchronises the query runner's metadata).
 */
export class AddFleetNodeCliVersions1795020000000 implements MigrationInterface {
    name = 'AddFleetNodeCliVersions1795020000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;
        if (!nodes.findColumnByName('cliVersions')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({ name: 'cliVersions', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;
        if (nodes.findColumnByName('cliVersions')) {
            await queryRunner.dropColumn('fleet_nodes', 'cliVersions');
        }
    }
}
