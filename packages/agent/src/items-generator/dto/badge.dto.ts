/**
 * Badge system for directory items
 * Badges can be added to repos mentioned in awesome directories
 * Each badge has only two possible values: A (good) or F (fail)
 */

export enum BadgeType {
    SECURITY = 'security',
    LICENSE = 'license',
    QUALITY = 'quality',
}

export enum BadgeValue {
    A = 'A', // Good/Pass
    F = 'F', // Fail
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
    domain_type?: string;
    domain_badges?: Record<
        string,
        {
            value: string;
            evaluated_at?: string;
            details?: string | null;
        }
    >;
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
