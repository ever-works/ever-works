import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * What kicked off this run.
 * - `heartbeat` — scheduled tick from `agent-heartbeat-dispatcher` cron.
 * - `manual`    — user clicked "Run heartbeat now" in the UI.
 * - `task`      — Task transitioned to `in_progress` with this Agent as assignee.
 * - `chat`      — `@<agent>` mention in a `task_chat_messages` row.
 * - `event`     — future use (webhook / external event hook; v2).
 */
export type AgentRunTriggerKind = 'heartbeat' | 'manual' | 'task' | 'chat' | 'event';

/**
 * Run lifecycle. Mirrors `WorkGenerationHistory` semantics:
 * - `queued`    — row inserted by dispatcher; Trigger.dev run pending.
 * - `running`   — worker picked it up.
 * - `completed` — terminal success.
 * - `failed`    — terminal failure (errorMessage populated).
 * - `cancelled` — user cancelled via UI / API.
 */
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One execution of an Agent (agents/plan.md §3.1, architecture/agents-skills-tasks.md §7).
 *
 * Created by the heartbeat dispatcher OR on Task transition OR on chat
 * mention. Holds the Trigger.dev run id for cancellation; carries the
 * summary the AI produced and any error.
 *
 * Cascade: hard CASCADE on `agents.id` is enforced by the migration so
 * archiving an Agent (soft-delete) does NOT lose run history but
 * delete-Agent DOES. Activity log preserves audit independently.
 */
@Entity({ name: 'agent_runs' })
@Index('idx_agent_runs_agent_started', ['agentId', 'startedAt'])
@Index('idx_agent_runs_status', ['status'])
@Index('idx_agent_runs_task', ['taskId'])
@Index('idx_agent_runs_chat_message', ['chatMessageId'])
export class AgentRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    agentId: string;

    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 16 })
    triggerKind: AgentRunTriggerKind;

    @Column({ type: 'varchar', length: 16 })
    status: AgentRunStatus;

    /** Trigger.dev run id; used to call `runs.cancel(...)` on user-initiated cancel. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    triggerRunId?: string | null;

    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    finishedAt?: Date | null;

    @Column({ type: 'int', nullable: true })
    durationMs?: number | null;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string | null;

    /** Free-text summary produced by the AI; surfaced in the dashboard. */
    @Column({ type: 'text', nullable: true })
    summary?: string | null;

    /** Populated only when `triggerKind = 'task'`. FK to `tasks.id` (added by Tasks migration). */
    @Column('uuid', { nullable: true })
    taskId?: string | null;

    /** Populated only when `triggerKind = 'chat'`. FK to `task_chat_messages.id`. */
    @Column('uuid', { nullable: true })
    chatMessageId?: string | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /**
     * Agent-memory session id for this run (follow-up to PR #1073 +
     * #1081). When an agent-memory provider is configured and the
     * user/work has it enabled, `AgentRunService.execute()` opens a
     * session at the start of the run and stores the returned id here
     * so observations saved during the run can be linked back to it
     * in audit + the eventual session-list UI. Null on:
     *
     * - Runs that started before this column existed.
     * - Runs where no agent-memory provider is enabled for the user
     *   or work.
     * - Runs where `openSession` failed (memory failures must never
     *   crash the agent run; we log + leave the column null).
     *
     * Length is a plain `varchar` rather than `uuid` because the
     * backend's id format is up to the agent-memory provider —
     * `@ever-works/agentmemory-plugin` happens to use ULIDs, but
     * future providers (mem0, zep) may not.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    memorySessionId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
