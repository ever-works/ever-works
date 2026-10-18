import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { FleetNodeGpuHealth, FleetNodeHealthResolution } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Computer health (FL-03) — the history behind "is this machine getting
 * worse?" (CONTRACTS §4.5, revision 3).
 *
 * ONE table, two resolutions:
 *   - `raw` — one row per accepted heartbeat that carried a snapshot, at
 *     most one per node per 55 s, kept 7 days;
 *   - `hourly` — one roll-up row per node per hour, whose percentages are
 *     the hour's MEANS and whose `cpuMax` / `memMax` / `diskMax` are its
 *     peaks, kept 90 days.
 * The roll-up and both retention windows run as one scheduled task on the
 * configured job runtime (Constitution IV); nothing is deleted on a read.
 *
 * Written only while `FLEET_HEALTH_HISTORY_ENABLED` is on. `at` is the
 * platform's RECEIPT time for a raw row and the hour's start for an hourly
 * one — never the machine's clock (U12).
 *
 * `nodeId` carries no foreign key, like `fleet_audit.nodeId`: history is
 * pruned by its own retention, never cascaded by a node's removal mid-sweep.
 * Raw uuid reference only (no relation), per the EW-654 cycle rule.
 *
 * Migration: `1796030000000-CreateFleetNodeHealthSamples`. Also registered
 * in `database/_entities-inventory.ts` (no `autoLoadEntities` here).
 */
@Entity({ name: 'fleet_node_health_samples' })
@Index('uq_fleet_node_health_samples_node_res_at', ['nodeId', 'resolution', 'at'], { unique: true })
@Index('idx_fleet_node_health_samples_res_at', ['resolution', 'at'])
export class FleetNodeHealthSample {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    nodeId: string;

    /** Receipt time (raw) or the hour's start (hourly). */
    @PortableDateColumn()
    at: Date;

    /** `raw` | `hourly` — validated in code, a `varchar` like every fleet enum. */
    @Column({ type: 'varchar', length: 8 })
    resolution: FleetNodeHealthResolution;

    @Column({ type: 'float', nullable: true })
    cpuPercent: number | null;

    @Column({ type: 'float', nullable: true })
    memPercent: number | null;

    /** `bigint` like `diskFreeMiB` (the bound is 1 EiB in MiB). */
    @Column({ type: 'bigint', nullable: true })
    memTotalMiB: string | number | null;

    @Column({ type: 'float', nullable: true })
    diskPercent: number | null;

    /** `bigint` — a STRING on Postgres, a number on sqlite; normalised by the repository. */
    @Column({ type: 'bigint', nullable: true })
    diskFreeMiB: string | number | null;

    @Column({ type: 'float', nullable: true })
    loadAvg1: number | null;

    /** `bigint` like `diskFreeMiB`: a century of seconds does not fit an int. */
    @Column({ type: 'bigint', nullable: true })
    uptimeSec: string | number | null;

    /** The GPU list as reported (raw rows only); null on hourly rows and when no GPU was known. */
    @Column({ type: 'simple-json', nullable: true })
    gpu: FleetNodeGpuHealth[] | null;

    /** Raw: as reported. Hourly: true when any sample of the hour said so. */
    @Column({ type: 'boolean', nullable: true })
    pendingReboot: boolean | null;

    /** Raw: as reported. Hourly: the hour's highest count. */
    @Column({ type: 'int', nullable: true })
    failedServices: number | null;

    /** Hourly only: the hour's peak CPU percent. Null on raw rows. */
    @Column({ type: 'float', nullable: true })
    cpuMax: number | null;

    /** Hourly only: the hour's peak memory percent. Null on raw rows. */
    @Column({ type: 'float', nullable: true })
    memMax: number | null;

    /** Hourly only: the hour's peak disk percent. Null on raw rows. */
    @Column({ type: 'float', nullable: true })
    diskMax: number | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
