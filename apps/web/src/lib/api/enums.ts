// Re-export enums from centralized contracts package
export { GenerationMethod, WebsiteRepositoryCreationMethod } from '@ever-works/contracts/api';

export {
    GenerateStatusType,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    DirectoryScheduleBillingMode,
} from '@ever-works/contracts/api';

// Web-specific enums (not shared with backend contracts)
export enum RepoProvider {
    GITHUB = 'github',
}

export enum OAuthProvider {
    GITHUB = 'github',
    GOOGLE = 'google',
}

export enum OAuthProcessType {
    LOGIN = 'login',
    CONNECT = 'connect',
}

/**
 * Roles for directory access.
 * - OWNER: Reserved for directory creator only (implicit, not assignable to members)
 * - MANAGER: Can edit directory and manage content, invite/remove members
 * - EDITOR: Can edit directory content but cannot manage members
 * - VIEWER: Read-only access to directory
 *
 * Note: OWNER role is returned for the directory creator when querying userRole.
 * Members can only be assigned MANAGER, EDITOR, or VIEWER roles.
 */
export enum DirectoryMemberRole {
    OWNER = 'owner',
    MANAGER = 'manager',
    EDITOR = 'editor',
    VIEWER = 'viewer',
}

/**
 * Roles that can be assigned to directory members.
 * OWNER is excluded as it's reserved for the directory creator.
 */
export const ASSIGNABLE_MEMBER_ROLES = [
    DirectoryMemberRole.MANAGER,
    DirectoryMemberRole.EDITOR,
    DirectoryMemberRole.VIEWER,
] as const;
