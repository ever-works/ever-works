import { WorkMemberRole } from './api/enums';

/**
 * Role hierarchy values for comparison.
 * Higher number = more permissions.
 */
const ROLE_HIERARCHY: Record<WorkMemberRole, number> = {
    [WorkMemberRole.OWNER]: 4,
    [WorkMemberRole.MANAGER]: 3,
    [WorkMemberRole.EDITOR]: 2,
    [WorkMemberRole.VIEWER]: 1,
};

/**
 * Check if a role has at least the specified minimum role level.
 */
export function hasRoleOrHigher(
    userRole: WorkMemberRole | undefined,
    minimumRole: WorkMemberRole,
): boolean {
    if (!userRole) return false;
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/**
 * Check if user can view the work (any role).
 */
export function canView(userRole: WorkMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, WorkMemberRole.VIEWER);
}

/**
 * Check if user can edit work content (editor, manager, or owner).
 */
export function canEdit(userRole: WorkMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, WorkMemberRole.EDITOR);
}

/**
 * Check if user can manage members (manager or owner).
 */
export function canManageMembers(userRole: WorkMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, WorkMemberRole.MANAGER);
}

/**
 * Check if user is the owner.
 */
export function isOwner(userRole: WorkMemberRole | undefined): boolean {
    return userRole === WorkMemberRole.OWNER;
}

/**
 * Check if user can delete the work (owner only).
 */
export function canDelete(userRole: WorkMemberRole | undefined): boolean {
    return isOwner(userRole);
}

/**
 * Check if user can access settings (managers and owners can view and edit settings).
 * Note: Delete is still owner-only and handled separately by canDelete.
 */
export function canAccessSettings(userRole: WorkMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, WorkMemberRole.MANAGER);
}

/**
 * Check if user can deploy (editor or higher).
 */
export function canDeploy(userRole: WorkMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, WorkMemberRole.EDITOR);
}

/**
 * Check if user can generate/update items (editor or higher).
 */
export function canGenerate(userRole: WorkMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, WorkMemberRole.EDITOR);
}

/**
 * Check if user can manage schedules (editor or higher).
 */
export function canManageSchedule(userRole: WorkMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, WorkMemberRole.EDITOR);
}

/**
 * Permission object for easy use in components.
 */
export interface WorkPermissions {
    canView: boolean;
    canEdit: boolean;
    canManageMembers: boolean;
    canDelete: boolean;
    canAccessSettings: boolean;
    canDeploy: boolean;
    canGenerate: boolean;
    canManageSchedule: boolean;
    isOwner: boolean;
    role: WorkMemberRole | undefined;
}

/**
 * Get all permissions for a user role.
 */
export function getPermissions(userRole: WorkMemberRole | undefined): WorkPermissions {
    return {
        canView: canView(userRole),
        canEdit: canEdit(userRole),
        canManageMembers: canManageMembers(userRole),
        canDelete: canDelete(userRole),
        canAccessSettings: canAccessSettings(userRole),
        canDeploy: canDeploy(userRole),
        canGenerate: canGenerate(userRole),
        canManageSchedule: canManageSchedule(userRole),
        isOwner: isOwner(userRole),
        role: userRole,
    };
}
