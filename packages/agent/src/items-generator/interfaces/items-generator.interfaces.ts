export interface WebPageData {
    source_url: string;
    retrieved_at: string; // ISO date string
    raw_content: string;
}

export interface RelevanceAssessment {
    relevant: boolean;
    relevance_score: number; // 0.0 to 1.0
    reason: string;
}

export interface TopicAnalysis {
    primary_keywords: string[];
    synonyms: string[];
    related_terms: string[];
    exclusion_terms: string[];
    item_types: string[];
}

export enum DomainType {
    SOFTWARE = 'software',
    ECOMMERCE = 'ecommerce',
    SERVICES = 'services',
    GENERAL = 'general',
}

export interface DomainAnalysis {
    domain_type: DomainType;
    confidence: number;
    item_noun?: string;
    expected_attributes?: string[];
    official_source_patterns?: string[];
    aggregator_domains?: string[];
}
