import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    FleetSessionEndedReason,
    FleetSessionKind,
    FleetSessionOutcome,
    FleetSessionProvider,
    FleetSessionRecordingState,
    FleetSessionState,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Sessions on computers (FL-04, CONTRACTS §4.2, R-1) — one persistent
 * interactive process on a Node: an agent CLI or a shell that keeps running
 * when nobody is watching.
 *
 * `id` is the PLATFORM's key; `daemonSessionId` is the NODE's key — the id
 * the session daemon on the machine knows the process by. The platform
 * names it at start (today the same value as `id`), and every fact the node
 * reports arrives keyed by `(nodeId, daemonSessionId)`, which is unique.
 *
 * The row carries machine facts, state and the terminal's last screen; an
 * Agent session's Run carries its cost, receipts and the board card
 * (R-1). Terminal bytes never touch this row except `lastScreen`, the last
 * 2 000 lines the daemon kept when the session ended (plain text, bounded).
 *
 * Written ONLY by `FleetSessionService` (start, node events, rename, end,
 * restart, reconciliation) and the session sweeper. FL-05 adds its five
 * attention columns in its own slot (`1796050000000`); FL-20 adds
 * `costCents` / `tokens` (`1796200000000`).
 *
 * Scope columns are raw uuids (no `@ManyToOne`) per the entity-cycle rule;
 * foreign keys live in the migration (`1796040000000-CreateFleetSessions`).
 * Registered in `database/_entities-inventory.ts` and `_entity-names.ts`.
 */
@Entity({ name: 'fleet_sessions' })
@Index('idx_fleet_sessions_node_state', ['nodeId', 'state'])
@Index('idx_fleet_sessions_user_state_activity', ['userId', 'state', 'lastActivityAt'])
@Index('idx_fleet_sessions_org_state', ['organizationId', 'state'])
@Index('uq_fleet_sessions_agent_run', ['agentRunId'], {
    unique: true,
    where: '"agentRunId" IS NOT NULL',
})
@Index('uq_fleet_sessions_node_daemon', ['nodeId', 'daemonSessionId'], { unique: true })
export class FleetSession {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Which machine. Set at start; never changes. */
    @Column({ type: 'uuid' })
    nodeId: string;

    /** The person who started it, or the Agent's owner. Every read is scoped through the Node's policy. Set at start. */
    @Column({ type: 'uuid' })
    userId: string;

    /** The Node's Organization binding when the session started (R-19 limits are enforced against it). Set at start. */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** `owner` | `agent` (R-5). Set at start. */
    @Column({ type: 'varchar', length: 8 })
    kind: FleetSessionKind;

    /** `claude-code` | `codex` | `shell` | `other:<id>`. Set at start. */
    @Column({ type: 'varchar', length: 64 })
    provider: FleetSessionProvider;

    /** The Agent driving it (Agent sessions only). Set at start. */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** The Agent session's one Run (R-1; `AgentRun.fleetSessionId` is the reverse). Set at start (P2). */
    @Column({ type: 'uuid', nullable: true })
    agentRunId?: string | null;

    /** The Checkout it started in, when it started in one (FL-14). Set at start. */
    @Column({ type: 'uuid', nullable: true })
    checkoutId?: string | null;

    /** The folder on the Node the process started in. Set at start. */
    @Column({ type: 'text' })
    cwd: string;

    /** 1–200 characters. Set at start; changed by rename (and by the node's `title` event). */
    @Column({ type: 'varchar', length: 200 })
    title: string;

    /** CONTRACTS §5.1. Written by the session service from node evidence; FL-05 derives `needs_you`/`done`/`idle`. */
    @Column({ type: 'varchar', length: 16, default: 'starting' })
    state: FleetSessionState;

    /** Set once, on leaving `working`/`needs_you` for `done`/`ended`. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    outcome?: FleetSessionOutcome | null;

    /** The node's id for the process. Set at start. */
    @Column({ type: 'varchar', length: 64 })
    daemonSessionId: string;

    /** The CLI's own session id, for resume and cost attribution (R-13). Written from the CLI's start evidence (P2 / FL-05). */
    @Column({ type: 'varchar', length: 128, nullable: true })
    providerSessionId?: string | null;

    /** The first message, REDACTED before it is written — a preview, never the raw text. Set at start. */
    @Column({ type: 'text', nullable: true })
    firstMessage?: string | null;

    /** The last 2 000 lines the daemon kept when the session ended (plain text, bounded). Written on `exited` / `lost`. */
    @Column({ type: 'text', nullable: true })
    lastScreen?: string | null;

    /** The ended session this one replaced (restart, spec FR-20). Set at start. */
    @Column({ type: 'uuid', nullable: true })
    restartOfSessionId?: string | null;

    /** `user:<id>` or `agent:<id>` — who asked for it (the Run's Agent when an Agent started its own). Set at start. */
    @Column({ type: 'varchar', length: 80 })
    startedBy: string;

    /** Last output the node reported (throttled), else the start. Written by start and `activity` events. */
    @PortableDateColumn({ nullable: true })
    lastActivityAt?: Date | null;

    /** When the node reported the process running (platform clock). */
    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    /** When the session ended (platform clock). */
    @PortableDateColumn({ nullable: true })
    endedAt?: Date | null;

    /** Why it ended (CONTRACTS §4.2). Set once, with `endedAt`. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    endedReason?: FleetSessionEndedReason | null;

    /** The process exit code, when the daemon saw one. Written on `exited`. */
    @Column({ type: 'int', nullable: true })
    exitCode?: number | null;

    /** `off` | `recording` | `stored` (R-9). Written by the recording path (P3). */
    @Column({ type: 'varchar', length: 12, default: 'off' })
    recordingState: FleetSessionRecordingState;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
