export interface SubmitItemResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    item_name: string;
    message: string;
    pr_number?: number;
    pr_url?: string;
    branch_name?: string;
    auto_merged?: boolean;
    error_details?: string;
}
