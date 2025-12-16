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
     * Get the owner member of a directory (role = OWNER).
     */
    async findOwner(directoryId: string): Promise<DirectoryMember | null> {
        return this.repository.findOne({
            where: { directoryId, role: DirectoryMemberRole.OWNER },
            relations: ['user'],
        });
    }

    /**
     * Transfer ownership from one user to another.
     * The current owner becomes a manager.
     */
    async transferOwnership(
        directoryId: string,
        currentOwnerId: string,
        newOwnerId: string,
    ): Promise<{ previousOwner: DirectoryMember | null; newOwner: DirectoryMember | null }> {
        // Demote current owner to manager
        await this.repository.update(
            { directoryId, userId: currentOwnerId },
            { role: DirectoryMemberRole.MANAGER },
        );

        // Promote new owner
        await this.repository.update(
            { directoryId, userId: newOwnerId },
            { role: DirectoryMemberRole.OWNER },
        );

        return {
            previousOwner: await this.findMember(directoryId, currentOwnerId),
            newOwner: await this.findMember(directoryId, newOwnerId),
        };
    }

    /**
     * Get members who can edit the directory (editors, managers, owners).
     */
    async findEditableMembers(directoryId: string): Promise<DirectoryMember[]> {
        return this.repository.find({
            where: {
                directoryId,
                role: In([
                    DirectoryMemberRole.OWNER,
                    DirectoryMemberRole.MANAGER,
                    DirectoryMemberRole.EDITOR,
                ]),
            },
            relations: ['user'],
        });
    }

    /**
     * Get members who can manage other members (owners and managers).
     */
    async findManagers(directoryId: string): Promise<DirectoryMember[]> {
        return this.repository.find({
            where: {
                directoryId,
                role: In([DirectoryMemberRole.OWNER, DirectoryMemberRole.MANAGER]),
            },
            relations: ['user'],
        });
    }
}
