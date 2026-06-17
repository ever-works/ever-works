import type { ItemData } from '@ever-works/contracts';

/**
 * Structured error codes for item generation failures.
 * These are surfaced to the client to drive actionable error messages
 * (e.g. "Go to Plugins to configure your Git provider").
 */
export type ItemGenerationErrorCode =
    | 'GIT_PROVIDER_NOT_CONFIGURED'
    | 'GIT_AUTH_FAILED'
    | 'GIT_REPO_NOT_CONFIGURED'
    | 'GIT_CLONE_FAILED'
    | 'GIT_PUSH_FAILED'
    | 'GIT_BRANCH_FAILED'
    | 'ITEM_NOT_FOUND'
    | 'ITEM_ALREADY_EXISTS'
    | 'AI_PROVIDER_NOT_CONFIGURED'
    | 'SCREENSHOT_NOT_CONFIGURED'
    | 'RATE_LIMIT_EXCEEDED'
    | 'QUOTA_EXCEEDED'
    | 'GENERIC_ERROR';

export interface SubmitItemResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    item_name: string;
    item_slug?: string;
    message: string;
    pr_number?: number;
    pr_url?: string;
    pr_title?: string;
    pr_body?: string;
    pr_branch_name?: string;
    auto_merged?: boolean;
    direct_commit?: boolean;
    /** The created item data (available on success) for immediate client-side list update */
    item?: ItemData;
    /** Structured error code for client-side actionable messaging */
    error_code?: ItemGenerationErrorCode;
}
