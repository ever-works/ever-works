import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { DirectoryMember } from '../../entities/directory-member.entity';
import { DirectoryMemberRole } from '../../entities/types';

@Injectable()
export class DirectoryMemberRepository {
    constructor(
        @InjectRepository(DirectoryMember)
        private readonly repository: Repository<DirectoryMember>,
    ) {}

    /**
     * Add a member to a directory with a specific role.
     */
    async addMember(
        directoryId: string,
        userId: string,
        role: DirectoryMemberRole,
        invitedById?: string,
    ): Promise<DirectoryMember> {
        const member = this.repository.create({
            directoryId,
            userId,
            role,
            invitedById,
        });
        return this.repository.save(member);
    }

    /**
     * Find a member by directory and user ID.
     */
    async findMember(directoryId: string, userId: string): Promise<DirectoryMember | null> {
        return this.repository.findOne({
            where: { directoryId, userId },
            relations: ['user', 'directory', 'invitedBy'],
        });
    }

    /**
     * Find a member by ID.
     */
    async findById(id: string): Promise<DirectoryMember | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['user', 'directory', 'invitedBy'],
        });
    }

    /**
     * Get all members of a directory.
     */
    async findByDirectory(directoryId: string): Promise<DirectoryMember[]> {
        return this.repository.find({
            where: { directoryId },
            relations: ['user', 'invitedBy'],
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Get all directory memberships for a user.
     */
    async findByUser(userId: string): Promise<DirectoryMember[]> {
        return this.repository.find({
            where: { userId },
            relations: ['directory', 'directory.user'],
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Get all directories a user has access to (via membership).
     * Returns the directory IDs.
     */
    async getAccessibleDirectoryIds(userId: string): Promise<string[]> {
        const members = await this.repository.find({
            where: { userId },
            select: ['directoryId'],
        });
        return members.map((m) => m.directoryId);
    }

    /**
     * Check if a user is a member of a directory.
     */
    async isMember(directoryId: string, userId: string): Promise<boolean> {
        const count = await this.repository.count({
            where: { directoryId, userId },
        });
        return count > 0;
    }

    /**
     * Check if a user has at least the specified role in a directory.
     */
    async hasRole(
        directoryId: string,
        userId: string,
        minimumRole: DirectoryMemberRole,
    ): Promise<boolean> {
        const member = await this.findMember(directoryId, userId);
        if (!member) return false;

        return member.hasRoleOrHigher(minimumRole);
    }

    /**
     * Update a member's role.
     */
    async updateRole(
        directoryId: string,
        userId: string,
        newRole: DirectoryMemberRole,
    ): Promise<DirectoryMember | null> {
        await this.repository.update({ directoryId, userId }, { role: newRole });
        return this.findMember(directoryId, userId);
    }

    /**
     * Remove a member from a directory.
     */
    async removeMember(directoryId: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ directoryId, userId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Remove all members from a directory.
     */
    async removeAllMembers(directoryId: string): Promise<number> {
        const result = await this.repository.delete({ directoryId });
        return result.affected ?? 0;
    }

    /**
     * Count members in a directory.
     */
    async countMembers(directoryId: string): Promise<number> {
        return this.repository.count({ where: { directoryId } });
    }

    /**
     * Find members by role in a directory.
     */
    async findByRole(directoryId: string, role: DirectoryMemberRole): Promise<DirectoryMember[]> {
        return this.repository.find({
            where: { directoryId, role },
            relations: ['user'],
        });
    }

    /**
     * Get members who can edit the directory (editors and managers).
     * Note: Directory creator (owner) is identified by directory.userId, not membership.
     */
    async findEditableMembers(directoryId: string): Promise<DirectoryMember[]> {
        return this.repository.find({
            where: {
                directoryId,
                role: In([DirectoryMemberRole.MANAGER, DirectoryMemberRole.EDITOR]),
            },
            relations: ['user'],
        });
    }

    /**
     * Get members who can manage other members (managers only).
     * Note: Directory creator (owner) is identified by directory.userId, not membership.
     */
    async findManagers(directoryId: string): Promise<DirectoryMember[]> {
        return this.repository.find({
            where: {
                directoryId,
                role: DirectoryMemberRole.MANAGER,
            },
            relations: ['user'],
        });
    }

    /**
     * Get member roles for a user across multiple directories in a single query.
     * Returns a Map of directoryId -> role for directories where the user is a member.
     */
    async getMemberRolesForDirectories(
        userId: string,
        directoryIds: string[],
    ): Promise<Map<string, DirectoryMemberRole>> {
        if (directoryIds.length === 0) {
            return new Map();
        }

        const members = await this.repository.find({
            where: {
                userId,
                directoryId: In(directoryIds),
            },
            select: ['directoryId', 'role'],
        });

        const roleMap = new Map<string, DirectoryMemberRole>();
        for (const member of members) {
            roleMap.set(member.directoryId, member.role);
        }
        return roleMap;
    }
}
