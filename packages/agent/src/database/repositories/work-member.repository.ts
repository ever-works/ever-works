import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkMemberRole } from '../../entities/types';

@Injectable()
export class WorkMemberRepository {
    constructor(
        @InjectRepository(WorkMember)
        private readonly repository: Repository<WorkMember>,
    ) {}

    /**
     * Add a member to a work with a specific role.
     */
    async addMember(
        workId: string,
        userId: string,
        role: WorkMemberRole,
        invitedById?: string,
    ): Promise<WorkMember> {
        const member = this.repository.create({
            workId,
            userId,
            role,
            invitedById,
        });
        return this.repository.save(member);
    }

    /**
     * Find a member by work and user ID.
     */
    async findMember(workId: string, userId: string): Promise<WorkMember | null> {
        return this.repository.findOne({
            where: { workId, userId },
            relations: ['user', 'work', 'invitedBy'],
        });
    }

    /**
     * Find a member by ID.
     */
    async findById(id: string): Promise<WorkMember | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['user', 'work', 'invitedBy'],
        });
    }

    /**
     * Get all members of a work.
     */
    async findByWork(workId: string): Promise<WorkMember[]> {
        return this.repository.find({
            where: { workId },
            relations: ['user', 'invitedBy'],
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Get all work memberships for a user.
     */
    async findByUser(userId: string): Promise<WorkMember[]> {
        return this.repository.find({
            where: { userId },
            relations: ['work', 'work.user'],
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Get all works a user has access to (via membership).
     * Returns the work IDs.
     */
    async getAccessibleWorkIds(userId: string): Promise<string[]> {
        const members = await this.repository.find({
            where: { userId },
            select: ['workId'],
        });
        return members.map((m) => m.workId);
    }

    /**
     * Check if a user is a member of a work.
     */
    async isMember(workId: string, userId: string): Promise<boolean> {
        const count = await this.repository.count({
            where: { workId, userId },
        });
        return count > 0;
    }

    /**
     * Check if a user has at least the specified role in a work.
     */
    async hasRole(
        workId: string,
        userId: string,
        minimumRole: WorkMemberRole,
    ): Promise<boolean> {
        const member = await this.findMember(workId, userId);
        if (!member) return false;

        return member.hasRoleOrHigher(minimumRole);
    }

    /**
     * Update a member's role.
     */
    async updateRole(
        workId: string,
        userId: string,
        newRole: WorkMemberRole,
    ): Promise<WorkMember | null> {
        await this.repository.update({ workId, userId }, { role: newRole });
        return this.findMember(workId, userId);
    }

    /**
     * Remove a member from a work.
     */
    async removeMember(workId: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ workId, userId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Remove all members from a work.
     */
    async removeAllMembers(workId: string): Promise<number> {
        const result = await this.repository.delete({ workId });
        return result.affected ?? 0;
    }

    /**
     * Count members in a work.
     */
    async countMembers(workId: string): Promise<number> {
        return this.repository.count({ where: { workId } });
    }

    /**
     * Find members by role in a work.
     */
    async findByRole(workId: string, role: WorkMemberRole): Promise<WorkMember[]> {
        return this.repository.find({
            where: { workId, role },
            relations: ['user'],
        });
    }

    /**
     * Get members who can edit the work (editors and managers).
     * Note: Work creator (owner) is identified by work.userId, not membership.
     */
    async findEditableMembers(workId: string): Promise<WorkMember[]> {
        return this.repository.find({
            where: {
                workId,
                role: In([WorkMemberRole.MANAGER, WorkMemberRole.EDITOR]),
            },
            relations: ['user'],
        });
    }

    /**
     * Get members who can manage other members (managers only).
     * Note: Work creator (owner) is identified by work.userId, not membership.
     */
    async findManagers(workId: string): Promise<WorkMember[]> {
        return this.repository.find({
            where: {
                workId,
                role: WorkMemberRole.MANAGER,
            },
            relations: ['user'],
        });
    }

    /**
     * Get member roles for a user across multiple works in a single query.
     * Returns a Map of workId -> role for works where the user is a member.
     */
    async getMemberRolesForWorks(
        userId: string,
        workIds: string[],
    ): Promise<Map<string, WorkMemberRole>> {
        if (workIds.length === 0) {
            return new Map();
        }

        const members = await this.repository.find({
            where: {
                userId,
                workId: In(workIds),
            },
            select: ['workId', 'role'],
        });

        const roleMap = new Map<string, WorkMemberRole>();
        for (const member of members) {
            roleMap.set(member.workId, member.role);
        }
        return roleMap;
    }
}
