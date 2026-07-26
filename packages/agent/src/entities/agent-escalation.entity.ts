import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type {
    AgentEscalationAttempt,
    AgentEscalationReasonCode,
    AgentEscalationStatus,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Judgment layer G3 — the escalation record.
 *
 * Written whenever an agent GIVES UP: the gate exhausted its attempts, a
 * guardrail refused an action, a budget/credit ceiling stopped the work,
 * or the merge policy refused the merge. Before this table those four
 * outcomes ended as a chat message and a log line, so "what is waiting on
 * me?" was unanswerable and the calibration data the judgment layer needs
 * (what was attempted → what the human decided) was never captured.
 *
 * **Why an entity and not `activity_log`.** The activity log is
 * user+Work scoped: it has no `taskId` column, no resolution state and a
 * 500-char `summary`. An escalation is read from the Task detail, must
 * carry the attempt trail, and must be closable. Reusing the log would
 * have meant adding all three to a table every feature writes to.
 *
 * Append-only apart from the resolution fields. Nothing here is a
 * lifecycle transition of the run/task — an escalation is a note pinned
 * to them.
 */
@Entity({ name: 'agent_escalations' })
// Task detail: open escalations for a Task, newest first.
@Index('idx_agent_escalation_task_status', ['taskId', 'status'])
// Digest + Work cockpit: everything open on a Work.
@Index('idx_agent_escalation_work_status', ['workId', 'status'])
// "What is waiting on ME" across every Work.
@Index('idx_agent_escalation_user_status', ['userId', 'status'])
export class AgentEscalation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Owner of the escalated work — the run's user. Always set: every
     * read path is owner-scoped, so a NULL here would be unreachable.
     */
    @Column({ type: 'uuid' })
    userId: string;

    /** Stable machine token; see `AgentEscalationReasonCode`. */
    @Column({ type: 'varchar', length: 32 })
    reasonCode: AgentEscalationReasonCode;

    @Column({ type: 'varchar', length: 16, default: 'open' })
    status: AgentEscalationStatus;

    @Column({ type: 'uuid', nullable: true })
    runId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    taskId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** One-line "what happened". Plain text — never rendered as markup. */
    @Column({ type: 'varchar', length: 500 })
    summary: string;

    /**
     * What a human should DECIDE, phrased as an instruction. This is the
     * field that makes the record actionable rather than archival.
     */
    @Column({ type: 'text' })
    decisionNeeded: string;

    /**
     * What was attempted before giving up, newest last. `simple-json`
     * like every other small structured column in this schema.
     */
    @Column({ type: 'simple-json', nullable: true })
    attempted?: AgentEscalationAttempt[] | null;

    @Column({ type: 'uuid', nullable: true })
    resolvedByUserId?: string | null;

    @Column({ type: 'text', nullable: true })
    resolutionNote?: string | null;

    @PortableDateColumn({ nullable: true })
    resolvedAt?: Date | null;

    /**
     * Idempotency key. The writers are retry-prone (a Trigger.dev task
     * that re-runs, a sweeper tick that re-scans), so every writer
     * derives a stable key (`${reasonCode}:${runId}`) and a duplicate
     * write is dropped instead of stacking identical cards on the Task.
     */
    @Index('uq_agent_escalation_dedup', { unique: true })
    @Column({ type: 'varchar', length: 200, nullable: true })
    dedupKey?: string | null;

    // Tier C scope denormalization (EW-657). No @ManyToOne — cycle
    // avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
