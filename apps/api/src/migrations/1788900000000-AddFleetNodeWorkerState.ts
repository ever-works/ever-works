import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Fleet health signals — worker state + notice bookkeeping (EW-776,
 * self-build finding OPS-02).
 *
 * The defect this closes: a heartbeat carried no worker state, so a
 * machine that had self-quarantined (the durable worker safety marker,
 * clearable only at that keyboard) kept reporting `online` while refusing
 * every job it was offered. `status` said healthy, the queue said nothing
 * was running, and — under the runbook's recommended `local-wait`, where
 * there is no cloud fallback — nothing anywhere told the owner. Nothing
 * told them a PC had gone dark either.
 *
 * Six nullable columns on `fleet_nodes`, in two groups:
 *
 *  1. What the machine reports — `workerState` (`idle | working | paused |
 *     quarantined | throttled`), `workerStateReason`, and
 *     `workerStateChangedAt`, which moves only on a TRANSITION so
 *     "quarantined since 03:14" survives the beats that follow.
 *  2. Notice dedup markers — `offlineNoticedAt`, `offlineLongNoticedAt`,
 *     `quarantineNoticedAt`. `InboxService.notice` files
 *     unconditionally and has no dedup of its own, so "exactly one notice
 *     per transition" has to be a CAS on a column somewhere; the node row
 *     is the one thing both the heartbeat and the offline sweep already
 *     touch. Each marker is cleared when the node recovers, which is what
 *     re-arms the next outage.
 *
 * NO DEFAULTS on any of them, on purpose. NULL is the honest backfill:
 * an existing row genuinely has never reported a worker state, and
 * defaulting it to `'idle'` would state — in the schema — the exact
 * fabrication this whole slice exists to end.
 *
 * Also adds `idx_fleet_nodes_status_heartbeat`. The health sweep reads
 * `(userId, status, lastHeartbeatAt)` twice per owner-scoped list, and
 * that list is polled by the runner pill from every dashboard page.
 * `idx_fleet_nodes_user` already narrows by owner; this one covers the
 * rest of the predicate.
 *
 * NOT included: a foreign key on `fleet_agent_node_affinities.nodeId`.
 * That table deliberately has none (see
 * `1787508800000-CreateFleetAgentNodeAffinity`), and adding one now would
 * change documented semantics AND fail on any database that already holds
 * a pin to a deleted node. The cascade ships as an explicit transactional
 * delete in `FleetNodeRepository.delete` instead, covered by
 * `fleet-node.repository.integration.spec.ts`.
 *
 * Portable DDL (`TableColumn` / `TableIndex`) because CI and the e2e stack
 * run better-sqlite3 while production runs Postgres. Forward-only with a
 * guard per step, so a partially-applied database converges rather than
 * aborting; `down()` reverses all of it.
 */
export class AddFleetNodeWorkerState1788900000000 implements MigrationInterface {
    name = 'AddFleetNodeWorkerState1788900000000';

    /** Column name → its portable definition. Order is the order they are added. */
    private static readonly COLUMNS: ReadonlyArray<{ name: string; column: () => TableColumn }> = [
        {
            name: 'workerState',
            column: () =>
                new TableColumn({
                    name: 'workerState',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                }),
        },
        {
            name: 'workerStateReason',
            column: () =>
                new TableColumn({
                    name: 'workerStateReason',
                    type: 'varchar',
                    length: '500',
                    isNullable: true,
                }),
        },
        {
            name: 'workerStateChangedAt',
            column: () =>
                new TableColumn({
                    name: 'workerStateChangedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
        },
        {
            name: 'offlineNoticedAt',
            column: () =>
                new TableColumn({ name: 'offlineNoticedAt', type: 'timestamp', isNullable: true }),
        },
        {
            name: 'offlineLongNoticedAt',
            column: () =>
                new TableColumn({
                    name: 'offlineLongNoticedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
        },
        {
            name: 'quarantineNoticedAt',
            column: () =>
                new TableColumn({
                    name: 'quarantineNoticedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
        },
    ];

    private static readonly INDEX_NAME = 'idx_fleet_nodes_status_heartbeat';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        for (const { name, column } of AddFleetNodeWorkerState1788900000000.COLUMNS) {
            if (!nodes.findColumnByName(name)) {
                await queryRunner.addColumn('fleet_nodes', column());
            }
        }

        const indexName = AddFleetNodeWorkerState1788900000000.INDEX_NAME;
        const hasIndex = nodes.indices.some((index) => index.name === indexName);
        if (
            !hasIndex &&
            nodes.findColumnByName('status') &&
            nodes.findColumnByName('lastHeartbeatAt')
        ) {
            await queryRunner.createIndex(
                'fleet_nodes',
                new TableIndex({ name: indexName, columnNames: ['status', 'lastHeartbeatAt'] }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        const indexName = AddFleetNodeWorkerState1788900000000.INDEX_NAME;
        if (nodes.indices.some((index) => index.name === indexName)) {
            await queryRunner.dropIndex('fleet_nodes', indexName);
        }

        for (const { name } of [...AddFleetNodeWorkerState1788900000000.COLUMNS].reverse()) {
            if (nodes.findColumnByName(name)) {
                await queryRunner.dropColumn('fleet_nodes', name);
            }
        }
    }
}
