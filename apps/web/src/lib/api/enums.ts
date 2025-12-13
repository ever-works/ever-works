export enum RepoProvider {
    GITHUB = 'github',
}

export enum OAuthProvider {
    GITHUB = 'github',
    GOOGLE = 'google',
}

export enum GenerateStatusType {
    GENERATING = 'generating',
    GENERATED = 'generated',
    ERROR = 'error',
    CANCELLED = 'cancelled',
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
    DOMAIN_DETECTION = 'domain-detection',
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
    MARKDOWN_GENERATION = 'markdown-generation',
}

export enum OAuthProcessType {
    LOGIN = 'login',
    CONNECT = 'connect',
}

export enum DirectoryScheduleCadence {
    HOURLY = 'hourly',
    DAILY = 'daily',
    WEEKLY = 'weekly',
    MONTHLY = 'monthly',
}

export enum DirectoryScheduleStatus {
    DISABLED = 'disabled',
    ACTIVE = 'active',
    PAUSED = 'paused',
    CANCELED = 'canceled',
}

export enum DirectoryScheduleBillingMode {
    SUBSCRIPTION = 'subscription',
    USAGE = 'usage',
}
