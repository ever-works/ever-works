export type ClassToObject<T> = {
    [K in keyof T]: T[K];
};

export enum GenerateStatusType {
    GENERATING = 'generating',
    GENERATED = 'generated',
    ERROR = 'error',
    CANCELLED = 'cancelled',
}

export type GenerateStatus = {
    status: GenerateStatusType;
    step?: string;
    error?: string;
};

export enum DirectoryScheduleCadence {
    HOURLY = 'hourly',
    DAILY = 'daily',
    WEEKLY = 'weekly',
    MONTHLY = 'monthly',
}

export enum DirectoryScheduleStatus {
    DISABLED = 'disabled',
    ACTIVE = 'active',
    PAUSED = 'paused',
    CANCELED = 'canceled',
}

export enum DirectoryScheduleBillingMode {
    SUBSCRIPTION = 'subscription',
    USAGE = 'usage',
}

export enum SubscriptionPlanCode {
    FREE = 'free',
    STANDARD = 'standard',
    PREMIUM = 'premium',
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

export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];
