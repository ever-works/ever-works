// Re-export enums from centralized contracts
export {
    GenerateStatusType,
    WorkScheduleCadence,
    WorkScheduleStatus,
    WorkScheduleBillingMode,
} from '@ever-works/contracts/api';

export type { ProvidersDto } from '@ever-works/contracts/api';

export type ClassToObject<T> = {
    [K in keyof T]: T[K];
};

// Re-import types for use in this file
import type { GenerateStatusType, GenerationStepLog } from '@ever-works/contracts/api';

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
    /** Recent log entries for live display during generation */
    recentLogs?: GenerationStepLog[];
};

export enum SubscriptionPlanCode {
    FREE = 'free',
    STANDARD = 'standard',
    PREMIUM = 'premium',
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

export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

export enum DomainEnvironment {
    PRODUCTION = 'production',
    STAGING = 'staging',
    DEVELOPMENT = 'development',
}

export interface CommunityPrState {
    processedPrNumbers: number[];
    processedPrs?: Array<{
        number: number;
        updatedAt: string;
        outcome: 'applied' | 'ignored';
    }>;
    lastProcessedAt?: string;
    totalItemsAdded?: number;
    lastError?: string | null;
}
