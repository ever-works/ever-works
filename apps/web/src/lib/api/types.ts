export type APIResponse<T> = {
    status: 'success' | 'error' | 'pending';
} & T;

export interface MessageResponse {
    success: boolean;
    message?: string;
    response?: string;
    error?: string;
    metadata?: Record<string, any>;
}

export interface Category {
    id: string;
    name: string;
    description?: string;
    icon_url?: string;
    priority?: number;
}

export interface Badge {
    value: string;
    evaluated_at?: string;
    details?: string | null;
    type?: string; // Legacy field for backward compatibility
}

export type ItemBadges = Record<string, Badge>;

export interface BadgeEvaluationResult {
    badges: ItemBadges;
    evaluation_summary: string;
    evaluated_at: string;
    domain_type?: string;
}

export interface Tag {
    id: string;
    name: string;
}

export interface Brand {
    id: string;
    name: string;
    logo_url?: string;
    website?: string;
}

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    order?: number;
    source_url: string;
    category: string | string[];
    slug?: string;
    tags: string[] | Tag[];
    markdown?: string;
    badges?: ItemBadges;
    brand?: string | Brand;
    brand_logo_url?: string | null;
    images?: string[];
}
