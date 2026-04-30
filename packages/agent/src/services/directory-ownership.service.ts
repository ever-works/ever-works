import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryMemberRepository } from '@src/database/repositories/directory-member.repository';
import { Directory } from '@src/entities/directory.entity';
import { DirectoryMemberRole } from '@src/entities/types';
import { DirectoryMember } from '@src/entities/directory-member.entity';

export interface DirectoryAccessResult {
    directory: Directory;
    member: DirectoryMember | null;
    role: DirectoryMemberRole;
    isCreator: boolean;
}

@Injectable()
export class DirectoryOwnershipService {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
    ) {}

    /**
     * Ensure a user has access to a directory and return detailed access information.
     * Access is granted if the user is the creator OR has a membership record.
     */
    async ensureAccess(
        directoryId: string,
        userId: string,
        minimumRole?: DirectoryMemberRole,
    ): Promise<DirectoryAccessResult> {
        const directory = await this.directoryRepository.findById(directoryId);

        if (!directory) {
            throw new NotFoundException({
                status: 'error',
                message: `Directory with id '${directoryId}' not found`,
            });
        }

        const isCreator = directory.userId === userId;

        // Creator always has owner-level access
        if (isCreator) {
            // Check minimum role if specified (creator always passes as owner)
            if (minimumRole) {
                const hasRequiredRole = this.roleIsAtLeast(DirectoryMemberRole.OWNER, minimumRole);
                if (!hasRequiredRole) {
                    throw new ForbiddenException({
                        status: 'error',
                        message: 'You do not have the required permission level for this action',
                    });
                }
            }

            return {
                directory,
                member: null,
                role: DirectoryMemberRole.OWNER,
                isCreator: true,
            };
        }

        // Check membership for non-creators
        const member = await this.directoryMemberRepository.findMember(directoryId, userId);

        if (!member) {
            throw new ForbiddenException({
                status: 'error',
                message: 'You do not have permission to access this directory',
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
            directory,
            member,
            role: member.role,
            isCreator: false,
        };
    }

    /**
     * Ensure user can view the directory (any access level).
     */
    async ensureCanView(directoryId: string, userId: string): Promise<DirectoryAccessResult> {
        return this.ensureAccess(directoryId, userId, DirectoryMemberRole.VIEWER);
    }

    /**
     * Ensure user can edit the directory content.
     */
    async ensureCanEdit(directoryId: string, userId: string): Promise<DirectoryAccessResult> {
        return this.ensureAccess(directoryId, userId, DirectoryMemberRole.EDITOR);
    }

    /**
     * Ensure user can manage directory members.
     */
    async ensureCanManageMembers(
        directoryId: string,
        userId: string,
    ): Promise<DirectoryAccessResult> {
        return this.ensureAccess(directoryId, userId, DirectoryMemberRole.MANAGER);
    }

    /**
     * Ensure user is the owner of the directory.
     */
    async ensureIsOwner(directoryId: string, userId: string): Promise<DirectoryAccessResult> {
        return this.ensureAccess(directoryId, userId, DirectoryMemberRole.OWNER);
    }

    /**
     * Check if a user has access to a directory without throwing.
     */
    async hasAccess(directoryId: string, userId: string): Promise<boolean> {
        try {
            await this.ensureAccess(directoryId, userId);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get the user's role in a directory, or null if no access.
     */
    async getUserRole(directoryId: string, userId: string): Promise<DirectoryMemberRole | null> {
        const directory = await this.directoryRepository.findById(directoryId);

        if (!directory) {
            return null;
        }

        // Creator always has owner role
        if (directory.userId === userId) {
            return DirectoryMemberRole.OWNER;
        }

        const member = await this.directoryMemberRepository.findMember(directoryId, userId);
        return member?.role || null;
    }

    /**
     * Helper to check if one role is at least as powerful as another.
     */
    private roleIsAtLeast(role: DirectoryMemberRole, minimumRole: DirectoryMemberRole): boolean {
        const roleHierarchy: Record<DirectoryMemberRole, number> = {
            [DirectoryMemberRole.OWNER]: 4,
            [DirectoryMemberRole.MANAGER]: 3,
            [DirectoryMemberRole.EDITOR]: 2,
            [DirectoryMemberRole.VIEWER]: 1,
        };

        return roleHierarchy[role] >= roleHierarchy[minimumRole];
    }
}
