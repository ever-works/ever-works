import { DirectoryMemberRole } from './api/enums';

/**
 * Role hierarchy values for comparison.
 * Higher number = more permissions.
 */
const ROLE_HIERARCHY: Record<DirectoryMemberRole, number> = {
    [DirectoryMemberRole.OWNER]: 4,
    [DirectoryMemberRole.MANAGER]: 3,
    [DirectoryMemberRole.EDITOR]: 2,
    [DirectoryMemberRole.VIEWER]: 1,
};

/**
 * Check if a role has at least the specified minimum role level.
 */
export function hasRoleOrHigher(
    userRole: DirectoryMemberRole | undefined,
    minimumRole: DirectoryMemberRole,
): boolean {
    if (!userRole) return false;
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/**
 * Check if user can view the directory (any role).
 */
export function canView(userRole: DirectoryMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, DirectoryMemberRole.VIEWER);
}

/**
 * Check if user can edit directory content (editor, manager, or owner).
 */
export function canEdit(userRole: DirectoryMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, DirectoryMemberRole.EDITOR);
}

/**
 * Check if user can manage members (manager or owner).
 */
export function canManageMembers(userRole: DirectoryMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, DirectoryMemberRole.MANAGER);
}

/**
 * Check if user is the owner.
 */
export function isOwner(userRole: DirectoryMemberRole | undefined): boolean {
    return userRole === DirectoryMemberRole.OWNER;
}

/**
 * Check if user can delete the directory (owner only).
 */
export function canDelete(userRole: DirectoryMemberRole | undefined): boolean {
    return isOwner(userRole);
}

/**
 * Check if user can access settings (managers and owners can view and edit settings).
 * Note: Delete is still owner-only and handled separately by canDelete.
 */
export function canAccessSettings(userRole: DirectoryMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, DirectoryMemberRole.MANAGER);
}

/**
 * Check if user can deploy (editor or higher).
 */
export function canDeploy(userRole: DirectoryMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, DirectoryMemberRole.EDITOR);
}

/**
 * Check if user can generate/update items (editor or higher).
 */
export function canGenerate(userRole: DirectoryMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, DirectoryMemberRole.EDITOR);
}

/**
 * Check if user can manage schedules (editor or higher).
 */
export function canManageSchedule(userRole: DirectoryMemberRole | undefined): boolean {
    return hasRoleOrHigher(userRole, DirectoryMemberRole.EDITOR);
}

/**
 * Permission object for easy use in components.
 */
export interface DirectoryPermissions {
    canView: boolean;
    canEdit: boolean;
    canManageMembers: boolean;
    canDelete: boolean;
    canAccessSettings: boolean;
    canDeploy: boolean;
    canGenerate: boolean;
    canManageSchedule: boolean;
    isOwner: boolean;
    role: DirectoryMemberRole | undefined;
}

/**
 * Get all permissions for a user role.
 */
export function getPermissions(userRole: DirectoryMemberRole | undefined): DirectoryPermissions {
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
