// Re-export types from contracts
export type {
    Category,
    Tag,
    Brand,
    Badge,
    ItemBadges,
    BadgeEvaluationResult,
    ItemData,
    Collection,
    ItemSourceReachabilityStatus,
    ItemSourceAccuracyStatus,
} from '@ever-works/contracts';

// Web-specific types
export type APIResponse<T> = {
    status: 'success' | 'error' | 'pending';
} & T;

export interface MessageResponse {
    success: boolean;
    message?: string;
    response?: string;
    error?: string;
    metadata?: Record<string, unknown>;
}
