/**
 * Configuration format that matches .env.example structure
 * Stores flat key-value pairs like environment variables
 */
export interface EverWorksConfig {
    // App Configuration
    APP_TYPE: 'cli' | 'api' | 'test';

    // GitHub Configuration
    GH_APIKEY: string;
    GH_OWNER: string;

    // Git Configuration
    GIT_NAME: string;
    GIT_EMAIL: string;

    // Deployment Providers
    DEPLOY_TOKEN?: string;

    // AI Plugin Configurations
    PLUGIN_OPENROUTER_API_KEY?: string;
    PLUGIN_OPENROUTER_DEFAULT_MODEL?: string;
    PLUGIN_OPENROUTER_BASE_URL?: string;

    PLUGIN_OPENAI_API_KEY?: string;
    PLUGIN_OPENAI_DEFAULT_MODEL?: string;

    PLUGIN_GOOGLE_API_KEY?: string;
    PLUGIN_GOOGLE_DEFAULT_MODEL?: string;

    PLUGIN_ANTHROPIC_API_KEY?: string;
    PLUGIN_ANTHROPIC_DEFAULT_MODEL?: string;

    PLUGIN_GROQ_API_KEY?: string;
    PLUGIN_GROQ_DEFAULT_MODEL?: string;

    PLUGIN_OLLAMA_BASE_URL?: string;
    PLUGIN_OLLAMA_DEFAULT_MODEL?: string;

    // Search Services
    EXTRACT_CONTENT_SERVICE: 'tavily' | 'local';
    WEB_SEARCH_SERVICE: 'tavily';
    PLUGIN_TAVILY_API_KEY?: string;

    // Database Configuration (for future use)
    DATABASE_TYPE?: 'sqlite' | 'postgres' | 'mysql' | 'mariadb';
    DATABASE_IN_MEMORY?: string;
    DATABASE_LOGGING?: string;
}

/**
 * Partial configuration for setup process
 * Using Record to allow dynamic key assignment
 */
export type PartialEverWorksConfig = Record<string, any>;

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}
