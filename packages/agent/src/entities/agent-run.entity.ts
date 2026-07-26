import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';
import type { GateStatus, TaskAcceptanceCheck, TaskCheckResult } from '@ever-works/contracts';

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
// Run orchestration (Wave 4 M1) — cheap per-Work concurrency counts +
// Sessions-view grouping both scan (workId, status).
@Index('idx_agent_runs_work_status', ['workId', 'status'])
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

    // ── Quality gates ──────────────────────────────────────────────
    /**
     * The acceptance checks this run is judged by, snapshotted at dispatch
     * time via `resolveAcceptanceChecks(task, work)`. A snapshot, not a
     * reference: editing the Task or the Work mid-run must not change what
     * an in-flight run is graded against.
     */
    @Column({ type: 'simple-json', nullable: true })
    resolvedChecks?: TaskAcceptanceCheck[] | null;

    /**
     * Per-check outcomes keyed by `TaskAcceptanceCheck.id`. `null` until
     * the gate runner (a later milestone — this PR is schema only) reports.
     */
    @Column({ type: 'simple-json', nullable: true })
    checkResults?: TaskCheckResult[] | null;

    /**
     * Aggregate gate outcome. `null` on runs that predate quality gates or
     * that never reached the gate (crashed/cancelled before it). varchar(12)
     * fits every `GateStatus` member.
     */
    @Column({ type: 'varchar', length: 12, nullable: true })
    gateStatus?: GateStatus | null;

    /**
     * Gate attempts consumed by this run. NOT NULL default 0 so existing
     * rows read as "never attempted" rather than unknown; bounded by
     * `resolveMaxGateAttempts` (1..5) once the runner lands.
     */
    @Column({ type: 'int', default: 0 })
    gateAttempts: number;

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

    // ── Streaming-terminal columns (M4). All nullable: NULL means "this
    // run has no terminal" — every pre-existing and non-interactive run.
    // INVARIANT (schema test): agent_runs gains no content/transcript
    // bytes — terminal output lives in log chunks + the relay window.

    /** Run intends a long-lived interactive session (park/resume-able). */
    @Column({ type: 'boolean', default: false })
    persistent: boolean;

    /** `starting | attached | ended` — live terminal lifecycle. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    terminalState?: string | null;

    /** `completed | crashed | closed | parked` (+ provider hints). */
    @Column({ type: 'varchar', length: 32, nullable: true })
    terminalEndedReason?: string | null;

    /** Which terminal-stream plugin hosted the session. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    terminalProviderId?: string | null;

    /**
     * The pipeline CLI's own resume id (conversation lifetime — sibling
     * of `memorySessionId`). Park kills the process but keeps this, so
     * Resume = new run + this id handed to the pipeline plugin.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    cliSessionId?: string | null;

    /** Sweeper input: stale heartbeat + live terminalState ⇒ crashed. */
    // MUST be @PortableDateColumn, not a raw `type: 'timestamp'` column: the
    // e2e stack (and CI) runs better-sqlite3, which has no `timestamp` type, so
    // a raw timestamp makes TypeORM's metadata validation throw
    // `DataTypeNotSupportedError` and the API cannot boot AT ALL there. The
    // sibling startedAt/finishedAt columns use the same decorator.
    @PortableDateColumn({ nullable: true })
    lastHeartbeatAt?: Date | null;

    /** Highest published stdout seq (transcript/replay bookkeeping). */
    @Column({ type: 'int', nullable: true })
    lastFrameSeq?: number | null;
    /** Per-run workspace audit (worktree-per-Task isolation):
     *  `{ provider, path?, baseSha, branchRef, reused }`. The Task row
     *  keeps the durable subset (branchRef/branchState/baseSha); this is
     *  the run-scoped record for debugging and the run cockpit. */
    @Column({ type: 'simple-json', nullable: true })
    workspaceMeta?: {
        provider: string;
        path?: string;
        baseSha: string;
        branchRef: string;
        reused: boolean;
    } | null;

    // ── Run cockpit telemetry (kanban run cockpit, Wave 2) ──────────
    // Written by the worker via `AgentRunRepository.updateTelemetry` and
    // surfaced on the board through the `includeRun` list embed. All
    // nullable — runs that predate these columns (or workers that never
    // report) simply show no telemetry. branchRef/prUrl/prNumber are NOT
    // duplicated here: the Task row + `workspaceMeta` already carry them.

    /** One-line "what the agent is doing right now" feed for the board
     *  chip. Plain text only — the UI must never render it as markup. */
    @Column({ type: 'varchar', length: 300, nullable: true })
    currentActivity?: string | null;

    /** Cumulative token usage reported by the worker for this run. */
    @Column({ type: 'int', nullable: true })
    totalTokens?: number | null;

    /** Number of files the run has changed in its workspace so far. */
    @Column({ type: 'int', nullable: true })
    changedFilesCount?: number | null;

    // ── Run orchestration (Wave 4 M1). All additive; NULL/false on
    // every pre-existing row. The dispatch gate + Sessions list are the
    // consumers — nothing here changes the status state machine.

    /**
     * Denormalized Work scope, derived at creation from `task.workId`
     * when the run is task-attached (NULL otherwise — heartbeat/manual
     * runs have no Work). Powers per-Work concurrency counts and the
     * Sessions view's group-by-Work without a join per row.
     */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    /**
     * The run is parked on a question/approval for a human. Set by
     * lifecycle signals (never agent self-report prose); a run in this
     * state must NEVER be reaped by TTL sweeps. Boolean (not a status
     * member) so the existing status state machine and every CAS guard
     * keep working unchanged.
     */
    @Column({ type: 'boolean', default: false })
    awaitingInput: boolean;

    /**
     * Why a `queued` run has NOT been dispatched to the job runtime.
     * `concurrency-limit` = parked by `RunDispatchGateService`; NULL =
     * dispatched (or predates the gate). Cleared when a drain promotes
     * the run. Short machine token, never free text.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    queuedReason?: string | null;

    /**
     * State-aware sweeper (Wave 4 M6) — why this run needs a HUMAN, as a
     * short machine token (`queued-too-long`, `stale-parked`). NULL = the
     * run is fine, which is every pre-existing row and the overwhelming
     * majority of live ones.
     *
     * Distinct from `awaitingInput` on purpose: `awaitingInput` means the
     * AGENT asked a question, this means the PLATFORM noticed something
     * wrong with the run's lifecycle. The Sessions list filters on
     * "either" (`attention=1`), so the two never have to be merged into a
     * single overloaded flag.
     */
    @Column({ type: 'varchar', length: 32, nullable: true })
    attentionReason?: string | null;

    /** When {@link attentionReason} was raised. NULL whenever it is NULL. */
    @PortableDateColumn({ nullable: true })
    attentionAt?: Date | null;

    /**
     * Which pipeline plugin id executes this run (claude-code, codex,
     * standard-pipeline, …) — the Sessions view's "runs on" chip. NULL
     * for runs that predate the column or never reported.
     */
    @Column({ type: 'varchar', length: 32, nullable: true })
    runnerKind?: string | null;

    /**
     * Cumulative cost estimate for this run in integer cents. Sibling
     * of `totalTokens` (per-run rollup); the per-event source of truth
     * stays `plugin_usage_events.costCents`.
     */
    @Column({ type: 'int', nullable: true })
    costCents?: number | null;

    // ── Run steering (Wave 4 M5). Both additive; NULL/false on every
    // pre-existing row. The steering service writes them, the executing
    // run's tool loop reads them between iterations.

    /**
     * FIFO queue of steering messages waiting to be injected into the
     * LIVE run. `RunSteeringService.steer()` appends while the run is
     * `queued`/`running`; the tool loop drains the queue between model
     * round-trips and appends each entry as a `user` turn, then clears
     * the column. NULL = nothing pending (the overwhelmingly common
     * case), so the column costs one text read per iteration and no
     * write at all on an unsteered run.
     *
     * Deliberately a queue, not a single slot: the UX contract is
     * "messages sent during an active stream are queued, never dropped".
     */
    @Column({ type: 'simple-json', nullable: true })
    pendingInput?: string[] | null;

    /**
     * Cooperative stop request. Set by `RunSteeringService.interrupt()`;
     * the tool loop checks it at the same checkpoint as the abort
     * signal and stops BETWEEN iterations, so the run ends cleanly with
     * a summary instead of being killed mid-round-trip. Distinct from
     * cancel: cancel kills the process and skips every side effect,
     * interrupt asks the agent to stop and completes the run honestly.
     */
    @Column({ type: 'boolean', default: false })
    interruptRequested: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
