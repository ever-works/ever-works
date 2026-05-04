import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Unique,
    JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Work } from './work.entity';
import { ClassToObject, WorkMemberRole } from './types';

/**
 * WorkMember entity represents the many-to-many relationship
 * between users and works with role-based access.
 *
 * This allows multiple users to access and manage the same work
 * with different permission levels.
 *
 * Note: Members can only have roles: MANAGER, EDITOR, or VIEWER.
 * OWNER role is reserved for the work creator (identified by work.userId).
 */
@Entity({ name: 'work_members' })
@Unique(['workId', 'userId']) // A user can only have one membership per work
export class WorkMember {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, (work) => work.members, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.workMemberships, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column({ type: 'varchar', default: WorkMemberRole.VIEWER })
    role: WorkMemberRole;

    @Column({ nullable: true })
    invitedById?: string;

    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'invitedById' })
    invitedBy?: ClassToObject<User>;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    /**
     * Check if this member has at least the specified role level.
     * Role hierarchy: manager > editor > viewer
     * Note: OWNER is not included as members cannot have OWNER role.
     */
    hasRoleOrHigher(role: WorkMemberRole): boolean {
        const roleHierarchy: Record<WorkMemberRole, number> = {
            [WorkMemberRole.OWNER]: 4,
            [WorkMemberRole.MANAGER]: 3,
            [WorkMemberRole.EDITOR]: 2,
            [WorkMemberRole.VIEWER]: 1,
        };

        return roleHierarchy[this.role] >= roleHierarchy[role];
    }

    /**
     * Check if this member can manage (add/remove/update) other members.
     * Only managers can manage members (OWNER role is for work creator only).
     */
    canManageMembers(): boolean {
        return this.role === WorkMemberRole.MANAGER;
    }

    /**
     * Check if this member can edit work content.
     */
    canEdit(): boolean {
        return this.hasRoleOrHigher(WorkMemberRole.EDITOR);
    }
}
