/**
 * Configuration format that matches .env.example structure
 * Stores flat key-value pairs like environment variables
 */
export interface EverWorksConfig {
    // App Configuration
    APP_TYPE: 'cli' | 'api' | 'test';

    // GitHub Configuration
    GITHUB_APIKEY: string;
    GITHUB_OWNER: string;

    // Git Configuration
    GIT_NAME: string;
    GIT_EMAIL: string;

    // Deployment Providers
    VERCEL_TOKEN?: string;

    // AI Configuration
    AI_DEFAULT_PROVIDER: string;
    AI_FALLBACK_PROVIDERS: string; // Comma-separated list

    // AI Provider Configurations
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    OPENAI_TEMPERATURE?: string;
    OPENAI_MAX_TOKENS?: string;

    GOOGLE_API_KEY?: string;
    GOOGLE_MODEL?: string;
    GOOGLE_TEMPERATURE?: string;
    GOOGLE_MAX_TOKENS?: string;

    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_MODEL?: string;
    ANTHROPIC_TEMPERATURE?: string;
    ANTHROPIC_MAX_TOKENS?: string;

    OPENROUTER_API_KEY?: string;
    OPENROUTER_MODEL?: string;
    OPENROUTER_TEMPERATURE?: string;
    OPENROUTER_MAX_TOKENS?: string;

    OLLAMA_API_KEY?: string;
    OLLAMA_MODEL?: string;
    OLLAMA_TEMPERATURE?: string;
    OLLAMA_MAX_TOKENS?: string;
    OLLAMA_BASE_URL?: string;

    MISTRAL_API_KEY?: string;
    MISTRAL_MODEL?: string;
    MISTRAL_TEMPERATURE?: string;
    MISTRAL_MAX_TOKENS?: string;

    DEEPSEEK_API_KEY?: string;
    DEEPSEEK_MODEL?: string;
    DEEPSEEK_TEMPERATURE?: string;
    DEEPSEEK_MAX_TOKENS?: string;
    DEEPSEEK_BASE_URL?: string;

    GROQ_API_KEY?: string;
    GROQ_MODEL?: string;
    GROQ_TEMPERATURE?: string;
    GROQ_MAX_TOKENS?: string;

    // Search Services
    EXTRACT_CONTENT_SERVICE: 'tavily' | 'naive';
    WEB_SEARCH_SERVICE: 'tavily' | 'google-sr';
    TAVILY_API_KEY?: string;

    // Database Configuration (for future use)
    DATABASE_TYPE?: 'sqlite' | 'postgres' | 'mysql' | 'mariadb';
    DATABASE_IN_MEMORY?: string;
    DATABASE_LOGGING?: string;
}

/**
 * Partial configuration for setup process
 * Using Record to allow dynamic key assignment
 */
export type PartialEverWorksConfig = Record<string, string | undefined>;

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}
