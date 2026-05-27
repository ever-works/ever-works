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

/**
 * Single point of authority for "can this user do X to this Work?".
 *
 * **Access model — two-tier with implicit promotion:**
 *   - **Creator** (`work.userId === userId`) is implicitly `OWNER`
 *     without needing a `work_members` row. There is no path to
 *     downgrade the creator — ownership transfer is the only way
 *     to revoke creator access (lives elsewhere; see
 *     `WorkMemberService` notes).
 *   - **Non-creator** needs a `work_members` row with the right
 *     role. No row = `ForbiddenException`.
 *
 * **Method semantics worth knowing:**
 *
 *   - **`ensureAccess` without `minimumRole`** passes for ANY
 *     member regardless of role (and for the creator). It's the
 *     "do you have any membership" gate. `ensureCanView` is the
 *     explicit "at least viewer" form — same effect today but
 *     clearer intent at call sites.
 *
 *   - **`hasAccess` swallows EVERY exception**, including the
 *     `NotFoundException` thrown when the Work doesn't exist.
 *     Callers can't distinguish "work doesn't exist" from "you
 *     have no access" — if you need to surface the difference,
 *     call `ensureAccess` directly and handle the typed
 *     exceptions yourself.
 *
 *   - **`getUserRole` returns `null` on missing work**, not throw
 *     — deliberately inconsistent with `ensureAccess` so it can
 *     be used in conditional UI logic without try/catch.
 *
 *   - **`findByIdForAccess`** (vs `findById`) is a narrower query
 *     that only loads the fields needed for an access decision.
 *     Don't swap it for `findById` to "share code" — the perf
 *     gain matters on hot paths.
 *
 * **`roleIsAtLeast` vs `member.hasRoleOrHigher` duplication.**
 * The same hierarchy lives in two places: the local numeric map
 * here (used in the creator branch where there's no member
 * object) and the entity method (used in the membership branch).
 * If you reorder/add roles, you MUST update BOTH — the enum
 * order itself is not authoritative.
 */
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
        const work = await this.workRepository.findByIdForAccess(workId);

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
    async ensureCanManageMembers(workId: string, userId: string): Promise<WorkAccessResult> {
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
        const work = await this.workRepository.findByIdForAccess(workId);

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
