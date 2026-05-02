import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { WorkMemberRepository } from '@src/database/repositories/work-member.repository';
import { Work } from '@src/entities/work.entity';
import { WorkMemberRole } from '@src/entities/types';
import { WorkMember } from '@src/entities/work-member.entity';

export interface WorkAccessResult {
    work: Work;
    member: WorkMember | null;
    role: WorkMemberRole;
    isCreator: boolean;
}

@Injectable()
export class WorkOwnershipService {
    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
    ) {}

    /**
     * Ensure a user has access to a work and return detailed access information.
     * Access is granted if the user is the creator OR has a membership record.
     */
    async ensureAccess(
        workId: string,
        userId: string,
        minimumRole?: WorkMemberRole,
    ): Promise<WorkAccessResult> {
        const work = await this.workRepository.findById(workId);

        if (!work) {
            throw new NotFoundException({
                status: 'error',
                message: `Work with id '${workId}' not found`,
            });
        }

        const isCreator = work.userId === userId;

        // Creator always has owner-level access
        if (isCreator) {
            // Check minimum role if specified (creator always passes as owner)
            if (minimumRole) {
                const hasRequiredRole = this.roleIsAtLeast(WorkMemberRole.OWNER, minimumRole);
                if (!hasRequiredRole) {
                    throw new ForbiddenException({
                        status: 'error',
                        message: 'You do not have the required permission level for this action',
                    });
                }
            }

            return {
                work,
                member: null,
                role: WorkMemberRole.OWNER,
                isCreator: true,
            };
        }

        // Check membership for non-creators
        const member = await this.workMemberRepository.findMember(workId, userId);

        if (!member) {
            throw new ForbiddenException({
                status: 'error',
                message: 'You do not have permission to access this work',
            });
        }

        // Check minimum role if specified
        if (minimumRole && !member.hasRoleOrHigher(minimumRole)) {
            throw new ForbiddenException({
                status: 'error',
                message: 'You do not have the required permission level for this action',
            });
        }

        return {
            work,
            member,
            role: member.role,
            isCreator: false,
        };
    }

    /**
     * Ensure user can view the work (any access level).
     */
    async ensureCanView(workId: string, userId: string): Promise<WorkAccessResult> {
        return this.ensureAccess(workId, userId, WorkMemberRole.VIEWER);
    }

    /**
     * Ensure user can edit the work content.
     */
    async ensureCanEdit(workId: string, userId: string): Promise<WorkAccessResult> {
        return this.ensureAccess(workId, userId, WorkMemberRole.EDITOR);
    }

    /**
     * Ensure user can manage work members.
     */
    async ensureCanManageMembers(
        workId: string,
        userId: string,
    ): Promise<WorkAccessResult> {
        return this.ensureAccess(workId, userId, WorkMemberRole.MANAGER);
    }

    /**
     * Ensure user is the owner of the work.
     */
    async ensureIsOwner(workId: string, userId: string): Promise<WorkAccessResult> {
        return this.ensureAccess(workId, userId, WorkMemberRole.OWNER);
    }

    /**
     * Check if a user has access to a work without throwing.
     */
    async hasAccess(workId: string, userId: string): Promise<boolean> {
        try {
            await this.ensureAccess(workId, userId);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get the user's role in a work, or null if no access.
     */
    async getUserRole(workId: string, userId: string): Promise<WorkMemberRole | null> {
        const work = await this.workRepository.findById(workId);

        if (!work) {
            return null;
        }

        // Creator always has owner role
        if (work.userId === userId) {
            return WorkMemberRole.OWNER;
        }

        const member = await this.workMemberRepository.findMember(workId, userId);
        return member?.role || null;
    }

    /**
     * Helper to check if one role is at least as powerful as another.
     */
    private roleIsAtLeast(role: WorkMemberRole, minimumRole: WorkMemberRole): boolean {
        const roleHierarchy: Record<WorkMemberRole, number> = {
            [WorkMemberRole.OWNER]: 4,
            [WorkMemberRole.MANAGER]: 3,
            [WorkMemberRole.EDITOR]: 2,
            [WorkMemberRole.VIEWER]: 1,
        };

        return roleHierarchy[role] >= roleHierarchy[minimumRole];
    }
}
