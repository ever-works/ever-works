// Re-export enums from centralized contracts package
export { GenerationMethod, WebsiteRepositoryCreationMethod } from '@ever-works/contracts/api';

export {
    GenerateStatusType,
    WorkScheduleCadence,
    WorkScheduleStatus,
    WorkScheduleBillingMode,
} from '@ever-works/contracts/api';

export enum OAuthProvider {
    GITHUB = 'github',
    GOOGLE = 'google',
    FACEBOOK = 'facebook',
    LINKEDIN = 'linkedin',
}

/**
 * Roles for work access.
 * - OWNER: Reserved for work creator only (implicit, not assignable to members)
 * - MANAGER: Can edit work and manage content, invite/remove members
 * - EDITOR: Can edit work content but cannot manage members
 * - VIEWER: Read-only access to work
 *
 * Note: OWNER role is returned for the work creator when querying userRole.
 * Members can only be assigned MANAGER, EDITOR, or VIEWER roles.
 */
export enum WorkMemberRole {
    OWNER = 'owner',
    MANAGER = 'manager',
    EDITOR = 'editor',
    VIEWER = 'viewer',
}

/**
 * Roles that can be assigned to work members.
 * OWNER is excluded as it's reserved for the work creator.
 */
export const ASSIGNABLE_MEMBER_ROLES = [
    WorkMemberRole.MANAGER,
    WorkMemberRole.EDITOR,
    WorkMemberRole.VIEWER,
] as const;
