import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { TaskTemplate } from './task-template.entity';

/**
 * Tasks upgrades — one step of a workflow Task Template.
 *
 * `position` is the 0-based order within the template and the key that
 * `dependsOn` entries reference (an int[] of EARLIER positions —
 * validated acyclic at write time by `TaskTemplatesService`).
 *
 * Agent binding is a soft hint, not a hard FK: `agentId` points at a
 * concrete Agent the owner mapped; `agentTemplateSlug` names a starter
 * agent template (`starter-planner`, …) so seeded templates can suggest
 * a role before the user has created any Agents. Instantiation only
 * assigns `agentId` (when set and reachable); the slug is display/UX
 * metadata.
 */
@Entity({ name: 'task_template_steps' })
@Index('idx_task_template_steps_template', ['templateId', 'position'])
export class TaskTemplateStep {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    templateId: string;

    @ManyToOne(() => TaskTemplate, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'templateId' })
    template?: TaskTemplate;

    @Column({ type: 'int' })
    position: number;

    @Column({ type: 'varchar', length: 200 })
    title: string;

    /** Per-step agent prompt — appended to the sub-task description
     *  under a `## Agent prompt` heading at instantiation. */
    @Column({ type: 'text', nullable: true })
    prompt?: string | null;

    /** Concrete Agent to assign at instantiation. No @ManyToOne — the
     *  Agent may be deleted independently; reachability is validated at
     *  instantiation time and a stale id simply skips the assignment. */
    @Column({ type: 'uuid', nullable: true })
    agentId?: string | null;

    /** Starter-agent-template hint (e.g. `starter-planner`). */
    @Column({ type: 'varchar', length: 80, nullable: true })
    agentTemplateSlug?: string | null;

    @Column({ type: 'boolean', default: false })
    requiresApproval: boolean;

    /** 0-based positions of steps this one depends on (task_blocks
     *  edges at instantiation). simple-json int[]. */
    @Column({ type: 'simple-json', nullable: true })
    dependsOn?: number[] | null;

    @CreateDateColumn()
    createdAt: Date;
}
