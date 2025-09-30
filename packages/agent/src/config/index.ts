import { AiProviderType } from '@src/ai';
import { DatabaseType } from '@src/database';

type AppType = 'cli' | 'api';

export const config = {
    getEnvironment() {
        return process.env.NODE_ENV;
    },
    getAppType(): AppType {
        return (process.env.APP_TYPE as AppType) || 'api';
    },
    isCli() {
        return this.getAppType() === 'cli';
    },

    // Database configuration
    database: {
        getType() {
            return (process.env.DATABASE_TYPE as DatabaseType) || undefined;
        },
        getUrl() {
            return process.env.DATABASE_URL;
        },
        getHost() {
            return process.env.DATABASE_HOST;
        },
        getPort() {
            return process.env.DATABASE_PORT;
        },
        autoMigrate() {
            return process.env.DATABASE_AUTOMIGRATE !== 'false';
        },
        loggingEnabled() {
            return process.env.DATABASE_LOGGING === 'true';
        },
        sslMode() {
            return process.env.DATABASE_SSL_MODE === 'true';
        },
        databaseCaCert() {
            return process.env.DATABASE_CA_CERT;
        },
        getPath() {
            return process.env.DATABASE_PATH;
        },
        getInMemory() {
            return process.env.DATABASE_IN_MEMORY === 'true';
        },
        getUsername() {
            return process.env.DATABASE_USERNAME;
        },
        getPassword() {
            return process.env.DATABASE_PASSWORD;
        },
        getDatabaseName() {
            return process.env.DATABASE_NAME;
        },
    },

    // AI configuration
    ai: {
        getDefaultProvider(): AiProviderType {
            return (process.env.AI_DEFAULT_PROVIDER as AiProviderType) || 'openai';
        },
        getFallbackProviders() {
            return process.env.AI_FALLBACK_PROVIDERS;
        },

        // OpenAI
        openAi: {
            getModel() {
                return process.env.OPENAI_MODEL || 'gpt-4o';
            },
            getKey() {
                return process.env.OPENAI_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.OPENAI_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.OPENAI_MAX_TOKENS || '4096');
            },
        },

        // OpenRouter
        openRouter: {
            getModel() {
                return process.env.OPENROUTER_MODEL || 'gpt-4o';
            },
            getKey() {
                return process.env.OPENROUTER_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.OPENROUTER_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.OPENROUTER_MAX_TOKENS || '4096');
            },
            getBaseUrl() {
                return process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
            },
        },

        // Ollama
        ollama: {
            getKey() {
                return process.env.OLLAMA_API_KEY;
            },
            getModel() {
                return process.env.OLLAMA_MODEL || 'llama2';
            },
            getTemperature() {
                return parseFloat(process.env.OLLAMA_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.OLLAMA_MAX_TOKENS || '4096');
            },
            getBaseUrl() {
                return process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
            },
        },

        // Google AI (Gemini)
        google: {
            getModel() {
                return process.env.GOOGLE_MODEL || 'gemini-2.5-flash';
            },
            getKey() {
                return process.env.GOOGLE_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.GOOGLE_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.GOOGLE_MAX_TOKENS || '4096');
            },
            getBaseUrl() {
                return 'https://generativelanguage.googleapis.com/v1beta/openai/';
            },
        },

        // Anthropic (Claude)
        anthropic: {
            getModel() {
                return process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
            },
            getKey() {
                return process.env.ANTHROPIC_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.ANTHROPIC_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096');
            },
        },

        // Mistral AI
        mistral: {
            getModel() {
                return process.env.MISTRAL_MODEL || 'mistral-large-latest';
            },
            getKey() {
                return process.env.MISTRAL_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.MISTRAL_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.MISTRAL_MAX_TOKENS || '4096');
            },
        },

        // DeepSeek
        deepseek: {
            getModel() {
                return process.env.DEEPSEEK_MODEL || 'deepseek-chat';
            },
            getKey() {
                return process.env.DEEPSEEK_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.DEEPSEEK_MAX_TOKENS || '4096');
            },
            getBaseUrl() {
                return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
            },
        },

        // Groq
        groq: {
            getModel() {
                return process.env.GROQ_MODEL || 'llama-3.1-70b-versatile';
            },
            getKey() {
                return process.env.GROQ_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.GROQ_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.GROQ_MAX_TOKENS || '4096');
            },
        },
    },

    // Search configuration
    search: {
        getExtractContentService() {
            return (process.env.EXTRACT_CONTENT_SERVICE as 'tavily' | 'naive') || 'tavily';
        },
        getWebSearchService() {
            return (process.env.WEB_SEARCH_SERVICE as 'tavily' | 'google-sr') || 'tavily';
        },
    },

    // GitHub configuration
    github: {
        getApiKey() {
            return process.env.GH_APIKEY;
        },
        getOwner() {
            return process.env.GH_OWNER;
        },
    },

    // Git configuration
    git: {
        getName() {
            return process.env.GIT_NAME;
        },
        getEmail() {
            return process.env.GIT_EMAIL;
        },
    },

    // Vercel configuration
    vercel: {
        getToken() {
            return process.env.VERCEL_TOKEN;
        },
    },

    // Tavily configuration
    tavily: {
        getApiKey() {
            return process.env.TAVILY_API_KEY;
        },
    },
};
