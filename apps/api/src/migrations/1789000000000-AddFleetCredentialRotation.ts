import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey } from 'typeorm';

/**
 * Fleet credential lifecycle + audit (EW-799, self-build slice AQ) —
 * the storage a NODE-INITIATED rotation needs.
 *
 * The defect this closes: `rotateCredentialForUser` kills the old
 * heartbeat secret the instant it replaces the hash, so re-keying a
 * machine means somebody walking to it and typing a token that expires
 * in 15 minutes. Across six machines on six desks that is a ceremony
 * nobody performs, and credentials therefore never rotate at all.
 *
 * Four NULLABLE columns on `fleet_nodes`, no backfill, no default, and
 * zero behaviour change on upgrade until a node actually rotates:
 *
 *  - `previousCredentialHash`      — sha256 of the credential replaced by
 *                                    the last self-rotation. Deliberately
 *                                    NOT unique and deliberately NOT part
 *                                    of `idx_fleet_nodes_credential`
 *                                    (UNIQUE on `enrollmentTokenHash`):
 *                                    `enroll` resolves rows BY that index,
 *                                    so a still-valid previous credential
 *                                    reachable from it would be a
 *                                    replayable enrollment token. This
 *                                    column is only ever read by node id.
 *  - `previousCredentialExpiresAt` — the end of the dual-accept window.
 *                                    The old credential dies on this
 *                                    clock whether or not the node ever
 *                                    calls back.
 *  - `rotationRequestedAt`         — the owner QUEUED a rotation
 *                                    (`POST /api/fleet/rotate-all`); the
 *                                    node rotates itself on its next beat.
 *  - `rotationRequestedByUserId`   — who queued it. FK to `users` with
 *                                    ON DELETE SET NULL, so the flag
 *                                    survives a purged operator.
 *
 * The audit half of the slice needs NO schema at all: `fleet_audit`
 * (`1788150000000-CreateFleetKillSwitchAndAudit`) already carries
 * `action` as a `varchar(64)` precisely so a new action name is a code
 * change, and its `nodeId` column was reserved for exactly these rows.
 *
 * Portable DDL (`TableColumn`) because CI and the e2e stack run
 * better-sqlite3 while production runs Postgres; every step is guarded on
 * the current table shape so a partially-applied database converges
 * rather than aborting, and `down()` reverses all of it.
 */
export class AddFleetCredentialRotation1789000000000 implements MigrationInterface {
    name = 'AddFleetCredentialRotation1789000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        if (!nodes.findColumnByName('previousCredentialHash')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({
                    name: 'previousCredentialHash',
                    type: 'varchar',
                    length: '128',
                    // NOT unique, on purpose — see the class docblock.
                    isNullable: true,
                }),
            );
        }
        if (!nodes.findColumnByName('previousCredentialExpiresAt')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({
                    name: 'previousCredentialExpiresAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
            );
        }
        if (!nodes.findColumnByName('rotationRequestedAt')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({
                    name: 'rotationRequestedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
            );
        }
        if (!nodes.findColumnByName('rotationRequestedByUserId')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({
                    name: 'rotationRequestedByUserId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        // Guarded on the table existing AND on the key not already being
        // there: the migration must not explode on a database whose user
        // table is not present yet, nor on a re-run.
        const withColumns = await queryRunner.getTable('fleet_nodes');
        const hasFk = (withColumns?.foreignKeys ?? []).some(
            (key) => key.name === 'fk_fleet_nodes_rotation_requested_by',
        );
        if (!hasFk && (await queryRunner.hasTable('users'))) {
            await queryRunner.createForeignKey(
                'fleet_nodes',
                new TableForeignKey({
                    name: 'fk_fleet_nodes_rotation_requested_by',
                    columnNames: ['rotationRequestedByUserId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    // SET NULL, not CASCADE: a purged operator must not
                    // take the node's pending rotation with them.
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        if (nodes.foreignKeys.some((key) => key.name === 'fk_fleet_nodes_rotation_requested_by')) {
            await queryRunner.dropForeignKey('fleet_nodes', 'fk_fleet_nodes_rotation_requested_by');
        }
        for (const column of [
            'rotationRequestedByUserId',
            'rotationRequestedAt',
            'previousCredentialExpiresAt',
            'previousCredentialHash',
        ]) {
            const table = await queryRunner.getTable('fleet_nodes');
            if (table?.findColumnByName(column)) {
                await queryRunner.dropColumn('fleet_nodes', column);
            }
        }
    }
}
