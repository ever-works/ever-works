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
