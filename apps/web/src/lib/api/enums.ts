export enum RepoProvider {
    GITHUB = 'github',
}

export enum OAuthProvider {
    GITHUB = 'github',
    GOOGLE = 'google',
}

export enum BadgeType {
    SECURITY = 'security',
    LICENSE = 'license',
    QUALITY = 'quality',
}

export enum BadgeValue {
    A = 'A', // Good/Pass
    F = 'F', // Fail
}

export enum GenerateStatusType {
    GENERATING = 'generating',
    GENERATED = 'generated',
    ERROR = 'error',
}

export enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

export enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    CREATE_USING_TEMPLATE = 'create-using-template',
}

export enum ItemsGeneratorStep {
    PROMPT_COMPARISON = 'prompt-comparison',
    PROMPT_PROCESSING = 'prompt-processing',
    AI_FIRST_ITEMS_GENERATION = 'ai-first-items-generation',
    SEARCH_QUERIES_GENERATION = 'search-queries-generation',
    WEB_SEARCH = 'web-search',
    CONTENT_RETRIEVAL = 'content-retrieval',
    CONTENT_FILTERING = 'content-filtering',
    ITEMS_EXTRACTION = 'items-extraction',
    DEDUPLICATION_AND_DATA_AGGREGATION = 'deduplication-and-data-aggregation',
    CATEGORIES_TAGS_PROCESSING = 'categories-tags-processing',
    SOURCES_VALIDATION = 'sources-validation',
    BADGES_PROCESSING = 'badges-processing',
    ITEMS_PROCESSING = 'items-processing',
}

export enum OAuthProcessType {
    LOGIN = 'login',
    CONNECT = 'connect',
}
