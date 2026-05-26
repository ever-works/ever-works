import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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

    @Column({ length: 16 })
    triggerKind: AgentRunTriggerKind;

    @Column({ length: 16 })
    status: AgentRunStatus;

    /** Trigger.dev run id; used to call `runs.cancel(...)` on user-initiated cancel. */
    @Column({ length: 64, nullable: true })
    triggerRunId?: string | null;

    @Column({ type: 'timestamp', nullable: true })
    startedAt?: Date | null;

    @Column({ type: 'timestamp', nullable: true })
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

    @CreateDateColumn()
    createdAt: Date;
}
