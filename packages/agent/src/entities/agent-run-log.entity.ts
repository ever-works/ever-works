import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Per-run structured log row (agents/plan.md §3.1). Same shape as
 * `WorkAgentRunLog` — mirrors that engine's posture deliberately so the
 * dashboards / activity feed can reuse one rendering code path.
 *
 * `step` is a short label (e.g. `'tool:createTask'`, `'prompt-assembly'`,
 * `'provider-call'`). `metadata` carries event-specific payload (token
 * counts, tool args summary, durations).
 *
 * Cascade: deletes with `agent_runs.id` (migration enforces FK CASCADE).
 */
@Entity({ name: 'agent_run_logs' })
@Index('idx_agent_run_logs_run_created', ['runId', 'createdAt'])
@Index('idx_agent_run_logs_run_level', ['runId', 'level'])
export class AgentRunLog {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column('uuid')
	runId: string;

	@Column({ length: 8 })
	level: 'INFO' | 'WARN' | 'ERROR';

	@Column({ length: 80 })
	step: string;

	@Column({ type: 'text' })
	message: string;

	@Column('simple-json', { nullable: true })
	metadata?: Record<string, unknown> | null;

	@CreateDateColumn()
	createdAt: Date;
}
