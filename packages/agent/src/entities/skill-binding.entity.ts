import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Skill } from './skill.entity';
import { User } from './user.entity';

/**
 * Skills feature — Phase 8.2 (spec.md `features/skills/plan.md §3.1`).
 *
 * `SkillBinding` is the row that connects a `Skill` to a target — an
 * Agent, a Work, a Mission, an Idea, or the user's tenant. Bindings
 * are scoped by ownership (userId), so cross-user reads must 404.
 *
 * `targetId` is nullable: when `targetType === 'tenant'`, the userId
 * column alone is enough to identify the binding. For any other
 * target type, the id of the owning entity is required.
 *
 * Resolution priority: lower `priority` wins. Bindings with
 * `injectIntoAgent = false` are excluded from
 * `AiFacadeService.assembleSystemMessage`. Bindings with
 * `injectIntoGenerator = true` are surfaced during Work generator
 * runs (Phase 10).
 */
export type SkillBindingTargetType = 'agent' | 'work' | 'mission' | 'idea' | 'tenant';

@Entity({ name: 'skill_bindings' })
@Index('uq_skill_binding', ['skillId', 'targetType', 'targetId'], { unique: true })
@Index('idx_skill_binding_target', ['targetType', 'targetId'])
@Index('idx_skill_binding_user', ['userId'])
export class SkillBinding {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    skillId: string;

    @ManyToOne(() => Skill, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'skillId' })
    skill?: Skill;

    @Column({ type: 'varchar', length: 16 })
    targetType: SkillBindingTargetType;

    @Column({ type: 'uuid', nullable: true })
    targetId?: string | null;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'boolean', default: true })
    injectIntoAgent: boolean;

    @Column({ type: 'boolean', default: false })
    injectIntoGenerator: boolean;

    @Column({ type: 'int', default: 100 })
    priority: number;

    @CreateDateColumn()
    createdAt: Date;
}
