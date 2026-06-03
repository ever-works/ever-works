import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Task } from './task.entity';

export type TaskRelationKind = 'related' | 'duplicates' | 'follow-up';

/**
 * Tasks feature — Phase 11.2. Soft relationship between Tasks for
 * navigation only — not a state-machine gate.
 */
@Entity({ name: 'task_relations' })
@Index('uq_task_relation', ['taskId', 'relatedTaskId'], { unique: true })
@Index('idx_task_related', ['relatedTaskId'])
export class TaskRelation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    // Security: IDOR guard — callers MUST verify that both taskId and
    // relatedTaskId belong to the same authenticated user (via
    // TasksService.addRelation → tasks.findByIdAndUser) BEFORE calling
    // TaskRelationRepository.add(). The entity schema carries no FK that
    // enforces ownership on the related side (cycle-avoidance, EW-654).
    // Any new code path that inserts a TaskRelation MUST re-implement the
    // ownership check; bypassing TasksService.addRelation is not safe.
    @Column({ type: 'uuid' })
    relatedTaskId: string;

    @Column({ type: 'varchar', length: 16 })
    kind: TaskRelationKind;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
