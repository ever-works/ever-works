// Re-export enums from centralized contracts
export {
    GenerateStatusType,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    DirectoryScheduleBillingMode,
} from '@ever-works/contracts/api';

export type { ProvidersDto } from '@ever-works/contracts/api';

export type ClassToObject<T> = {
    [K in keyof T]: T[K];
};

// Re-import types for use in this file
import type { GenerateStatusType } from '@ever-works/contracts/api';

export type GenerateStatus = {
    status: GenerateStatusType;
    /** Current step ID (e.g., "prompt-processing") */
    step?: string;
    /** Human-readable step name (from pipeline plugin) */
    stepName?: string;
    /** Current step index (0-based) */
    stepIndex?: number;
    /** Total number of steps in the pipeline */
    totalSteps?: number;
    /** Progress percentage (0-100) */
    progress?: number;
    /** Number of items processed so far */
    itemsProcessed?: number;
    /** Error message if status is ERROR */
    error?: string;
    /** Warnings from circuit breaker or degraded services */
    warnings?: string[];
};

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

export enum DomainEnvironment {
    PRODUCTION = 'production',
    STAGING = 'staging',
    DEVELOPMENT = 'development',
}

export interface CommunityPrState {
    processedPrNumbers: number[];
    lastProcessedAt?: string;
    totalItemsAdded?: number;
    lastError?: string | null;
}
