import type { ItemData } from '@ever-works/contracts';

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
    error_details?: string;
}
