import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';
import type { WorkflowRunTrace } from '../agents/workflow-run-trace';

/**
 * Run lifecycle. Deliberately the SAME five members as
 * {@link AgentRunStatus}, because a workflow run and an agent run are the
 * same kind of thing to everything that watches them — a dispatcher
 * creates the row, a worker picks it up, it ends one of three ways.
 *
 * - `queued`    — row inserted by the API; the Trigger.dev run is pending.
 * - `running`   — the worker picked it up.
 * - `completed` — the graph walked off the end with its last node green.
 * - `failed`    — a node failed uncaught, or the run could not proceed.
 * - `cancelled` — stopped by a human.
 */
export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One execution of a saved {@link Workflow} graph (judgment layer G5).
 *
 * PR #1986 made a graph something a user OWNS. This is what makes running
 * one something that LEAVES A TRACE — until now the only way to execute a
 * graph was an agent chat tool whose result was handed to a model and then
 * discarded, so nothing could be reviewed, re-read, or debugged after the
 * fact.
 *
 * ## Why the row is created by the API and finished by the worker
 *
 * The row is inserted `queued` by `POST /api/workflows/:id/run` BEFORE the
 * Trigger.dev task is enqueued, exactly as `dispatchAgentRun` pre-creates
 * an `agent_runs` row. That ordering is what makes the run observable from
 * the moment it is asked for: a request that returns 202 has already
 * produced something the caller can poll, even if the worker never starts.
 *
 * ## Why `blocked` is not a status here
 *
 * `WorkflowGraphExecutorService` distinguishes `failed` (the graph's
 * fault) from `blocked` (no node runner or decider was bound — retryable,
 * not the author's mistake). That distinction is preserved in
 * {@link failureCode} (`no-node-runner`, `llm-decide-unavailable`), which
 * is what those machine tokens are FOR, rather than by adding a sixth
 * status every consumer would have to learn. A blocked walk lands `failed`
 * with the code that says why.
 *
 * ## The trace is capped, and does not hold node outputs
 *
 * See `agents/workflow-run-trace.ts`. In short: `WorkflowRunResult.
 * nodeOutputs` can hold entire Knowledge Base documents for a `kb.search`
 * node, so persisting it verbatim would make one row's size a function of
 * how much content the user's KB holds. What is kept is which nodes ran,
 * whether each succeeded, and a capped final output.
 *
 * ## Scope
 *
 * Tier C: declaring BOTH `tenantId` and `organizationId` opts this entity
 * into `ScopeStampingSubscriber`, which stamps them from the active
 * request scope on insert — which is why the row must be created in the
 * API request context, and why neither column is ever set by hand (the
 * subscriber only fills `undefined`, so assigning `null` would suppress
 * it). As with `workflows`, there is NO scope XOR CHECK: the stamp means
 * ordinary rows carry an `organizationId`, and a copied XOR would abort
 * the migration on real data.
 */
@Entity({ name: 'workflow_runs' })
// Mirrors `idx_agent_runs_agent_started` — the run-history list for one
// workflow, newest first, is the only query this table exists to serve.
@Index('idx_workflow_runs_workflow_started', ['workflowId', 'startedAt'])
@Index('idx_workflow_runs_status', ['status'])
@Index('idx_workflow_runs_user', ['userId'])
@Index('idx_workflow_runs_org', ['organizationId'])
export class WorkflowRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The saved graph this run executed. */
    @Column('uuid')
    workflowId: string;

    /**
     * Owner. Denormalized from the workflow rather than joined, so an
     * owner-scoped read of a run never has to load the workflow — which is
     * what lets `GET /api/workflows/runs/:runId` answer 404 for a foreign
     * id with a single query.
     */
    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 16 })
    status: WorkflowRunStatus;

    /** Trigger.dev run id — the handle for cancellation and log lookup. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    triggerRunId?: string | null;

    // MUST be @PortableDateColumn, not a raw `type: 'timestamp'`: CI and
    // the e2e stack run better-sqlite3, which has no `timestamp` type, so
    // a raw one makes TypeORM's metadata validation throw
    // `DataTypeNotSupportedError` and the API cannot boot AT ALL there.
    // Same decorator as agent_runs' startedAt/finishedAt.
    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    finishedAt?: Date | null;

    @Column({ type: 'int', nullable: true })
    durationMs?: number | null;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string | null;

    /**
     * The bounded record of the walk — `visited`, per-node outcome,
     * traversed edges, decisions, run errors. Built by
     * `summarizeWorkflowRun`; never the raw executor result.
     */
    @Column({ type: 'simple-json', nullable: true })
    trace?: WorkflowRunTrace | null;

    /**
     * The last green node's output, capped at
     * `WORKFLOW_RUN_MAX_OUTPUT_CHARS`. Holds the VALUE when it fits and a
     * truncation marker string when it does not — {@link outputTruncated}
     * is what tells the two apart.
     */
    @Column({ type: 'simple-json', nullable: true })
    output?: unknown;

    @Column({ type: 'boolean', default: false })
    outputTruncated: boolean;

    /**
     * Why the run stopped, as a stable machine token
     * (`node-failed`, `max-steps-exceeded`, `no-node-runner`, …). NULL on
     * a completed run. Never rename these — they are persisted.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    failureCode?: string | null;

    /** The node the run stopped on. NULL when nothing had run yet. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    failedNodeId?: string | null;

    /** How many nodes executed. 0 on a queued row — nothing has run. */
    @Column({ type: 'int', default: 0 })
    stepCount: number;

    // Tenant + Organization scope FKs (Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, same posture as agent-run.entity.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
