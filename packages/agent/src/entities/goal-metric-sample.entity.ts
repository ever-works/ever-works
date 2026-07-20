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
import { PortableDateColumn } from './_types';

/**
 * One observed metric value for a Goal — the append-only time series
 * behind progress display and evaluation history (Goals & Metrics
 * spec FR-10, PR-8).
 *
 * Written exclusively by `GoalEvaluationService` after a successful
 * `MetricsFacadeService.getMetricValue` read (scheduled tick or
 * manual `POST /me/goals/:id/evaluate-now`). Rows are immutable —
 * no `updatedAt`, no update path. Failed provider reads append
 * nothing (spec FR-5: failures record no usage and no sample).
 *
 * `sampledAt` is the provider-reported observation instant
 * (`MetricSample.at`), which can differ from `createdAt` (when the
 * row was written) for providers that compute windowed aggregates.
 *
 * Retention: full history for now — spec §8 leaves per-Goal sample
 * capping as an open question; revisit if volume becomes a problem
 * (≥15-minute clamp bounds growth to ≤96 rows/Goal/day).
 */
@Entity({ name: 'goal_metric_samples' })
@Index('idx_goal_metric_samples_goal_sampled', ['goalId', 'sampledAt'])
export class GoalMetricSample {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    goalId: string;

    @ManyToOne(() => Goal, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'goalId' })
    goal?: Goal;

    /** Provider-reported observation instant (`MetricSample.at`). */
    @PortableDateColumn()
    sampledAt: Date;

    @Column({ type: 'float' })
    value: number;

    @CreateDateColumn()
    createdAt: Date;
}
