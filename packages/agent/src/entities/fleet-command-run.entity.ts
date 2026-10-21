import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    FleetCommandFailedReason,
    FleetCommandRunStatus,
    FleetLinkErrorCode,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Commands on computers (FL-12, CONTRACTS §4.4) — one computer's execution
 * of a `FleetCommand`: when it started and ended, how it ended, and the first
 * and last 64 KiB of what it printed (redacted). The machine keeps the full
 * output of its last 30 runs (`outputRef` names it there).
 *
 * A computer that refused before the command ran (offline, no `--manage`,
 * outside the `commands` audience, an older node) has a run `failed` with
 * `failedReason` null and the CONTRACTS §8 refusal in `errorCode` /
 * `errorHint` — the §4.4 `failedReason` enum names only how a run that RAN
 * failed. `errorCode`, `errorHint`, `outputBytes` and `capped` are FL-12's own
 * columns (lane-log decision 3, CONTRACTS revision 9).
 *
 * No foreign key on `nodeId`: the history outlives the computer, as
 * `fleet_audit.nodeId` does. `commandId` → `fleet_commands` CASCADE lives in
 * the migration (`1796120100000-CreateFleetCommandRuns`). Written ONLY by
 * `FleetCommandService`. FL-13 adds `scheduledFor` in its slot.
 */
@Entity({ name: 'fleet_command_runs' })
@Index('uq_fleet_command_runs_command_node_started', ['commandId', 'nodeId', 'startedAt'], {
    unique: true,
})
@Index('idx_fleet_command_runs_node_started', ['nodeId', 'startedAt'])
@Index('idx_fleet_command_runs_status', ['status'])
export class FleetCommandRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The Command. Set at creation. */
    @Column({ type: 'uuid' })
    commandId: string;

    /** The computer. Set at creation; no FK (history outlives the computer). */
    @Column({ type: 'uuid' })
    nodeId: string;

    /** When the platform sent it (platform clock). */
    @PortableDateColumn()
    startedAt: Date;

    /** When it ended (platform clock), null while running. */
    @PortableDateColumn({ nullable: true })
    endedAt?: Date | null;

    /** The process exit code, when the machine saw one. */
    @Column({ type: 'int', nullable: true })
    exitCode?: number | null;

    /** `running · done · failed · timeout · skipped-overlap · skipped-offline`. */
    @Column({ type: 'varchar', length: 16, default: 'running' })
    status: FleetCommandRunStatus;

    /** How a run that ran failed (CONTRACTS §4.4); null otherwise. */
    @Column({ type: 'varchar', length: 24, nullable: true })
    failedReason?: FleetCommandFailedReason | null;

    /** A refusal before it ran, or a start failure: the CONTRACTS §8 code. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    errorCode?: FleetLinkErrorCode | null;

    /** …and its hint (never a secret, never output). */
    @Column({ type: 'text', nullable: true })
    errorHint?: string | null;

    /** The first 64 KiB (all of it when it fit in 128 KiB), redacted. */
    @Column({ type: 'text', nullable: true })
    outputHead?: string | null;

    /** The last 64 KiB when the output was larger, redacted. */
    @Column({ type: 'text', nullable: true })
    outputTail?: string | null;

    /** Bytes between head and tail were not stored. */
    @Column({ type: 'boolean', default: false })
    truncated: boolean;

    /** The machine stopped keeping output at 10 MiB (spec U6). */
    @Column({ type: 'boolean', default: false })
    capped: boolean;

    /** Bytes printed, as far as the platform knows. */
    @Column({ type: 'int', default: 0 })
    outputBytes: number;

    /** The node's key for the full output it keeps (the run id), or null when it kept none. */
    @Column({ type: 'text', nullable: true })
    outputRef?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
