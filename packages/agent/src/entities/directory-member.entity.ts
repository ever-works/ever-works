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
import { Directory } from './directory.entity';
import { ClassToObject, DirectoryMemberRole } from './types';

/**
 * DirectoryMember entity represents the many-to-many relationship
 * between users and directories with role-based access.
 *
 * This allows multiple users to access and manage the same directory
 * with different permission levels.
 *
 * Note: Members can only have roles: MANAGER, EDITOR, or VIEWER.
 * OWNER role is reserved for the directory creator (identified by directory.userId).
 */
@Entity({ name: 'directory_members' })
@Unique(['directoryId', 'userId']) // A user can only have one membership per directory
export class DirectoryMember {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    directoryId: string;

    @ManyToOne(() => Directory, (directory) => directory.members, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'directoryId' })
    directory: ClassToObject<Directory>;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.directoryMemberships, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: ClassToObject<User>;

    @Column({ type: 'varchar', default: DirectoryMemberRole.VIEWER })
    role: DirectoryMemberRole;

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
    hasRoleOrHigher(role: DirectoryMemberRole): boolean {
        const roleHierarchy: Record<DirectoryMemberRole, number> = {
            [DirectoryMemberRole.OWNER]: 4,
            [DirectoryMemberRole.MANAGER]: 3,
            [DirectoryMemberRole.EDITOR]: 2,
            [DirectoryMemberRole.VIEWER]: 1,
        };

        return roleHierarchy[this.role] >= roleHierarchy[role];
    }

    /**
     * Check if this member can manage (add/remove/update) other members.
     * Only managers can manage members (OWNER role is for directory creator only).
     */
    canManageMembers(): boolean {
        return this.role === DirectoryMemberRole.MANAGER;
    }

    /**
     * Check if this member can edit directory content.
     */
    canEdit(): boolean {
        return this.hasRoleOrHigher(DirectoryMemberRole.EDITOR);
    }
}
