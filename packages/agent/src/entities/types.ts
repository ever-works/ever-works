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

/**
 * Pseudo-role used only on `WorkInvitation`. Accepting an `owner-claim`
 * invitation transfers `work.userId` to the claimant; it never appears
 * on a `work_members` row.
 */
export const INVITATION_ROLE_OWNER_CLAIM = 'owner-claim' as const;

export const ASSIGNABLE_INVITATION_ROLES = ['manager', 'editor', 'viewer'] as const;

export type AssignableInvitationRole = (typeof ASSIGNABLE_INVITATION_ROLES)[number];

export type InvitationRole = AssignableInvitationRole | typeof INVITATION_ROLE_OWNER_CLAIM;

export const ALL_INVITATION_ROLES = [
    ...ASSIGNABLE_INVITATION_ROLES,
    INVITATION_ROLE_OWNER_CLAIM,
] as const;

export enum WorkInvitationStatus {
    PENDING = 'pending',
    ACCEPTED = 'accepted',
    EXPIRED = 'expired',
    REVOKED = 'revoked',
}

export type RepoTransferRecord = {
    repo: string;
    status: 'completed' | 'pending_recipient_acceptance' | 'failed';
    providerAcceptanceUrl?: string;
    error?: string;
};

export type WorkInvitationTransferState = {
    status: 'not_required' | 'pending_recipient_acceptance' | 'completed' | 'failed';
    repoTransfers?: RepoTransferRecord[];
};

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
