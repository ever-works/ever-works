import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * Tasks upgrades — workflow Task Templates.
 *
 * A `TaskTemplate` is a reusable multi-step workflow shape: instantiating
 * it creates one parent Task plus one sub-task per `TaskTemplateStep`,
 * with dependency edges (`task_blocks`), per-step agent assignees
 * (`task_assignees`) and approval gates (`task_approvers`) wired up in a
 * single transaction (`TaskTemplatesService.instantiateTemplate`).
 *
 * Slug uniqueness is per-user for the same reason `tasks.slug` is —
 * every user gets their own seeded defaults, so a global unique would
 * collide on the second user.
 */
@Entity({ name: 'task_templates' })
@Index('uq_task_templates_slug', ['userId', 'slug'], { unique: true })
@Index('idx_task_templates_org', ['organizationId'])
export class TaskTemplate {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 200 })
    name: string;

    @Column({ type: 'varchar', length: 80 })
    slug: string;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    @Column({ type: 'simple-json', nullable: true })
    labels?: string[] | null;

    // Tenant + Organization scope FKs (EW-651 Tier A denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
