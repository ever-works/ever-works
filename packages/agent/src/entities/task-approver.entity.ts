import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Task, type TaskActorType } from './task.entity';
import { PortableDateColumn } from './_types';

export type TaskApprovalState = 'pending' | 'approved' | 'rejected';

/**
 * Tasks feature — Phase 11.2. Approvers gate the
 * `in_review → done` transition (via `Task.requireAllApprovers`).
 */
@Entity({ name: 'task_approvers' })
@Index('uq_task_approver', ['taskId', 'approverType', 'approverId'], { unique: true })
@Index('idx_task_approver_actor', ['approverType', 'approverId'])
export class TaskApprover {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    @Column({ type: 'varchar', length: 8 })
    approverType: TaskActorType;

    @Column({ type: 'uuid' })
    approverId: string;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    approvalState: TaskApprovalState;

    @PortableDateColumn({ nullable: true })
    approvedAt?: Date | null;

    // ── decision provenance (reviewer agent stage, slice AD, EW-811) ──
    //
    // Before this slice an `approvalState` of 'approved' carried NO
    // provenance at all: nothing on the row said who or what wrote it, at
    // which commit, or from which run. That was tolerable while nothing
    // ever wrote the column (`setState` had no production caller); it
    // stops being tolerable the moment an AGENT can, because "an agent
    // approved this" and "a person approved this" must never look like the
    // same row to a reader.
    //
    // These columns do NOT authorize anything. The merge gate slice AE
    // (EW-805) built reads `agent_action_proposals` and only that table,
    // and requires `decidedVia === 'user'` with a non-null human
    // `decidedById` there. `task_approvers` is read by exactly one gate —
    // `in_review → done` — and the value this slice writes here,
    // 'agent-review', does not exist in `AgentActionProposalDecidedVia`.

    /**
     * `user` | `agent-review` — see `TaskApproverDecidedVia` in
     * `tasks-domain/task-agent-review.ts`. NULL while the row is
     * `pending`, and on every row that predates this slice.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    decidedVia?: string | null;

    /** The `agent_runs.id` whose verdict wrote this row, when an agent did. */
    @Column({ type: 'uuid', nullable: true })
    decidedByRunId?: string | null;

    /**
     * The commit the decision was rendered against.
     *
     * Without it, an approval given for code that has since been
     * force-pushed away reads as current. `TaskAgentReviewService` refuses
     * to write a verdict whose head no longer matches the pull request's,
     * and this column is the durable record of which commit the row is
     * actually about.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    decidedHeadSha?: string | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
