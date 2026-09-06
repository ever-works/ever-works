import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Panic controls (EW-778) — the GLOBAL STOP FLAG.
 *
 * One row, id `'global'` (`FLEET_KILL_SWITCH_ID` in `@ever-works/contracts`),
 * seeded by the migration that creates the table. It is read by three
 * places, before any new unit of work can start:
 *
 *   - `RunDispatchGateService` (through the `RUN_KILL_SWITCH` port) —
 *     every new agent run is PARKED with `queuedReason='kill-switch'`;
 *   - `FleetRunRouterService` / the fleet-aware dispatcher — a run that
 *     somehow reaches routing is REFUSED, never sent to the cloud;
 *   - `FleetJobService.lease` — a node polling for work gets `[]`.
 *
 * ## Fail closed
 *
 * The migration SEEDS the row so that "row missing" can only mean
 * "migration not applied". `FleetKillSwitchService.state()` treats a
 * missing row — or any read error — as `stopped: true, unverified: true`.
 * A safety control whose absence meant "go" would not be one.
 *
 * ## What it does NOT do
 *
 * Setting the flag never cancels running work; that is the explicit,
 * separate `cancel-in-flight` step. Heartbeats and job completions keep
 * being accepted while the flag is set so a stopped fleet can still
 * settle.
 *
 * `setByUserId` is a raw uuid reference (no @ManyToOne, per the EW-654
 * cycle-avoidance rule); the FK to `users` (ON DELETE SET NULL) lives in
 * the migration.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`, so a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'fleet_kill_switch' })
export class FleetKillSwitch {
    /** Always `'global'` — a single-row table keyed by a fixed id. */
    @PrimaryColumn({ type: 'varchar', length: 32 })
    id: string;

    @Column({ type: 'boolean', default: false })
    stopped: boolean;

    /** Free-text reason recorded with a stop; cleared on clear. */
    @Column({ type: 'varchar', length: 500, nullable: true })
    reason: string | null;

    /** Who last flipped the switch (set OR clear). NULL = never touched / user purged. */
    @Column({ type: 'uuid', nullable: true })
    setByUserId: string | null;

    /** When the switch was last flipped (set OR clear). */
    @PortableDateColumn({ nullable: true })
    setAt: Date | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
