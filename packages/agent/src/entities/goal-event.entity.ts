import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Goal } from './goal.entity';

/**
 * What an orchestrator log line is ABOUT.
 *
 *   `route`    — the router picked an agent, and `message` carries the
 *                reasoning that picked it.
 *   `dispatch` — an iteration Task was created and handed to that agent.
 *   `complete` — the loop reached a terminal verdict (every DoD criterion
 *                closed, or the goal was cancelled).
 *   `limit`    — a budget / wall-clock / stuck ceiling tripped.
 *   `nudge`    — an operator injected a steering message into the live run.
 *   `control`  — an operator pause / resume / restart.
 *   `dod`      — a Definition-of-Done criterion changed state.
 */
export type GoalEventKind =
    | 'route'
    | 'dispatch'
    | 'complete'
    | 'limit'
    | 'nudge'
    | 'control'
    | 'dod';

export const GOAL_EVENT_KINDS: readonly GoalEventKind[] = [
    'route',
    'dispatch',
    'complete',
    'limit',
    'nudge',
    'control',
    'dod',
];

/**
 * Autonomy layer — one line of the per-Goal ORCHESTRATOR LOG.
 *
 * This table exists because the routing decision is the part of an
 * autonomous loop an operator most needs to audit and least can
 * reconstruct: "why did iteration 4 go to the research agent?" is
 * unanswerable from the Task rows alone, since the Task records only the
 * outcome of the decision, never its reasoning.
 *
 * Rows are IMMUTABLE and append-only (no `updatedAt`, no update path) —
 * the same posture as `goal_metric_samples`. A decision that turned out
 * wrong stays in the log; the correction is a new row.
 *
 * `message` holds the deterministic reasoning string produced by the
 * routing rule (v1 has no LLM in this path — AI routing would append its
 * own rationale here, which is exactly why the column is free text).
 *
 * No `@ManyToOne` to Agent/Task: those are raw uuid pointers by the
 * EW-654 no-cycle rule, and a log line must survive the deletion of the
 * thing it describes — an orchestrator log that vacates itself when an
 * agent is deleted is not an audit trail. Only `goalId` cascades, because
 * a log line about a deleted Goal has nothing left to explain.
 */
@Entity({ name: 'goal_events' })
// THE query this table exists to serve: one Goal's log, newest first.
@Index('idx_goal_events_goal_created', ['goalId', 'createdAt'])
@Index('idx_goal_events_goal_iteration', ['goalId', 'iteration'])
export class GoalEvent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    goalId: string;

    @ManyToOne(() => Goal, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'goalId' })
    goal?: Goal;

    /** Denormalized from the Goal so an owner-scoped read needs no join. */
    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 16 })
    kind: GoalEventKind;

    /** Human-readable line rendered verbatim in the Orchestrator tab. */
    @Column({ type: 'text' })
    message: string;

    /** Agent the line is about (routing target, nudge recipient). */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** Iteration Task the line is about. */
    @Column({ type: 'uuid', nullable: true })
    taskId?: string | null;

    /** Loop iteration this line belongs to (0 before the first dispatch). */
    @Column({ type: 'int', default: 0 })
    iteration: number;

    /**
     * Structured detail behind `message` (decision inputs, spend numbers,
     * candidate ids). `simple-json` ⇒ text; written already bounded by the
     * orchestrator, never a raw run transcript.
     */
    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown> | null;

    // Tier A scope columns (EW-655 pattern) — copied from the Goal at
    // write time. No @ManyToOne, same entities-import-cycle rule as
    // goal.entity.ts.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
