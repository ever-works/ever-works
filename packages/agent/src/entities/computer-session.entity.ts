import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type {
    ComputerChannel,
    ComputerCloseReason,
    ComputerControlSpan,
    ComputerQuality,
    ComputerSessionStatus,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Agent computers — one episode of a person watching the machine an Agent
 * works on.
 *
 * Not a Run and not a terminal session. A Run is the Agent's execution; a
 * terminal relay session lives only in memory and dies with the process.
 * This row is what survives: who watched which Node, for which Agent, bound
 * to which Run, and why it ended — the record an owner asks for when they
 * want to know who looked at their machine.
 *
 * Written ONLY by `ComputerSessionService` (open, first picture, stall,
 * close). The live pictures never touch it: they ride the relay, and only
 * the counters below are accounted here, throttled.
 *
 * Scope columns are raw uuids (no `@ManyToOne`) per the entity-cycle rule;
 * foreign keys live in the migration (`1791110000000-CreateComputerSessions`).
 * Also registered in `database/_entities-inventory.ts` and
 * `database/_entity-names.ts`.
 */
@Entity({ name: 'computer_sessions' })
@Index('idx_computer_sessions_user_status', ['userId', 'status'])
@Index('idx_computer_sessions_node_status', ['nodeId', 'status'])
@Index('idx_computer_sessions_agent', ['agentId', 'createdAt'])
@Index('idx_computer_sessions_run', ['runId'])
export class ComputerSession {
    /** Also the relay channel id and the WebSocket path segment. */
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The Node's owner — every read is scoped by it. Set on open. */
    @Column({ type: 'uuid' })
    userId: string;

    /** The Agent's Organization, when it has one. Set on open. */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Whose computer this is. Set on open. */
    @Column({ type: 'uuid' })
    agentId: string;

    /** Which machine. Set on open; never changes. */
    @Column({ type: 'uuid' })
    nodeId: string;

    /** Who opened it. Set on open. */
    @Column({ type: 'uuid' })
    openedByUserId: string;

    /** The Run in flight when the first picture arrived. Set once, never re-bound. */
    @Column({ type: 'uuid', nullable: true })
    runId?: string | null;

    /** The `computer-session` fleet job carrying it. Set right after enqueue. */
    @Column({ type: 'uuid', nullable: true })
    fleetJobId?: string | null;

    /** Channels requested on open. */
    @Column({ type: 'simple-json' })
    channels: ComputerChannel[];

    /** `screen` | `terminal`. Set on open; changed by the owner. */
    @Column({ type: 'varchar', length: 16, default: 'screen' })
    activeChannel: ComputerChannel;

    /** `sharp` | `smooth` | `steady`. Set on open; changed by the owner. */
    @Column({ type: 'varchar', length: 8, default: 'sharp' })
    quality: ComputerQuality;

    /** `requested` | `live` | `stalled` | `ended`. Written by the session service. */
    @Column({ type: 'varchar', length: 16, default: 'requested' })
    status: ComputerSessionStatus;

    /** The closed-set close reason. Written once, on close. */
    @Column({ type: 'varchar', length: 24, nullable: true })
    closeReason?: ComputerCloseReason | null;

    /** Ordered control spans, capped at 50. Written by the control path. */
    @Column({ type: 'simple-json', nullable: true })
    controlSpans?: ComputerControlSpan[] | null;

    /** Whether any of this session was recorded. Written by the recording path. */
    @Column({ type: 'boolean', default: false })
    recorded: boolean;

    /** Why it was not recorded, when that is known (`storage-unavailable`, `not-opted-in`). */
    @Column({ type: 'varchar', length: 32, nullable: true })
    recordingSkippedReason?: string | null;

    /** Pictures accepted by the relay. Accounted by the publish endpoint. */
    @Column({ type: 'int', default: 0 })
    frameCount: number;

    /**
     * Decoded picture bytes accepted — the bandwidth readout. `bigint`: a
     * STRING on Postgres, a number on sqlite; normalized in the service view.
     */
    @Column({ type: 'bigint', default: 0 })
    bytesOut: string | number;

    /** When the last picture arrived. Drives stall detection. */
    @PortableDateColumn({ nullable: true })
    lastFrameAt?: Date | null;

    /** When a controller last sent input. Drives idle release. */
    @PortableDateColumn({ nullable: true })
    lastInputAt?: Date | null;

    /** When the first picture arrived. */
    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    /** When the session ended. */
    @PortableDateColumn({ nullable: true })
    endedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
