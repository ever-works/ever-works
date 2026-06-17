import type { ItemGenerationErrorCode } from './submit-item-response.dto';

export interface RemoveItemResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    item_name: string;
    item_slug: string;
    message: string;
    pr_number?: number;
    pr_url?: string;
    pr_title?: string;
    pr_body?: string;
    pr_branch_name?: string;
    /** Structured error code for client-side actionable messaging */
    error_code?: ItemGenerationErrorCode;
}
