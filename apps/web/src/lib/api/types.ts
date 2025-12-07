import { BadgeType, BadgeValue } from './enums';

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
    type: BadgeType;
    value: BadgeValue;
    evaluated_at?: string; // ISO date string when badge was evaluated
    details?: string; // Optional details about the evaluation
}

export interface ItemBadges {
    security?: Badge;
    license?: Badge;
    quality?: Badge;
}

export interface BadgeEvaluationResult {
    badges: ItemBadges;
    evaluation_summary: string;
    evaluated_at: string;
}

/**
 * Badge evaluation criteria:
 *
 * SECURITY:
 * - "A" indicates that the server does not have known security vulnerabilities
 * - "F" indicates that the server has known security vulnerabilities
 *
 * LICENSE:
 * - "A" indicates that the server has a permissive license
 * - "F" indicates that the server either has a restrictive license or no license
 *
 * QUALITY:
 * - "A" indicates that we were able to successfully run the server
 * - "F" indicates that we were not able to successfully start the server
 */

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
    source_url: string;
    category: string | Category;
    slug?: string;
    tags: string[] | Tag[];
    markdown?: string;
    badges?: ItemBadges;
    brand?: string | Brand;
    brand_logo_url?: string | null;
    images?: string[];
}
