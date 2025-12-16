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
 * Roles for directory members.
 * - OWNER: Full control, can delete directory and manage all members
 * - MANAGER: Can edit directory and manage content, invite members (except owner)
 * - EDITOR: Can edit directory content but cannot manage members
 * - VIEWER: Read-only access to directory
 */
export enum DirectoryMemberRole {
    OWNER = 'owner',
    MANAGER = 'manager',
    EDITOR = 'editor',
    VIEWER = 'viewer',
}
