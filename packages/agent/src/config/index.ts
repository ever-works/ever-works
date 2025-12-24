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

    trigger: {
        isEnabled() {
            return process.env.TRIGGER_ENABLED === 'true';
        },
        getSecretKey() {
            return process.env.TRIGGER_SECRET_KEY;
        },
        getApiUrl() {
            return process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
        },
        getMachine() {
            return process.env.TRIGGER_MACHINE || undefined;
        },
        getInternalBaseUrl() {
            return process.env.TRIGGER_INTERNAL_API_URL;
        },
        getInternalSecret() {
            return process.env.TRIGGER_INTERNAL_SECRET;
        },
        shouldUseTrigger() {
            return this.isEnabled() && Boolean(this.getInternalSecret());
        },
    },

    // Database configuration
    database: {
        getType() {
            return (process.env.DATABASE_TYPE as DatabaseType) || 'better-sqlite3';
        },
        isSqlite() {
            return Boolean(config.database.getType()?.includes('sqlite'));
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
            getBaseUrl() {
                return process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
            },
            getEmbeddingModel() {
                return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
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
            getEmbeddingModel() {
                return process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
            },
        },

        // Ollama
        ollama: {
            getKey() {
                return process.env.OLLAMA_API_KEY || 'ollama';
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
            getEmbeddingModel() {
                return process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
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
            getEmbeddingModel() {
                return process.env.GOOGLE_EMBEDDING_MODEL || 'text-embedding-004';
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
            getBaseUrl() {
                return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/';
            },
            getEmbeddingModel() {
                return process.env.ANTHROPIC_EMBEDDING_MODEL || 'voyage-3.5';
            },
        },

        // Groq
        groq: {
            getModel() {
                return process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
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
            getBaseUrl() {
                return process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
            },
        },

        // Custom OpenAI-compatible provider
        custom: {
            getModel() {
                return process.env.CUSTOM_MODEL || 'default';
            },
            getKey() {
                return process.env.CUSTOM_API_KEY;
            },
            getTemperature() {
                return parseFloat(process.env.CUSTOM_TEMPERATURE || '0.7');
            },
            getMaxTokens() {
                return parseInt(process.env.CUSTOM_MAX_TOKENS || '4096');
            },
            getBaseUrl() {
                return process.env.CUSTOM_BASE_URL || '';
            },
        },

        // Model routing configuration
        routing: {
            isEnabled() {
                return process.env.MODEL_ROUTING_ENABLED === 'true';
            },
            isAutoEscalationEnabled() {
                return process.env.MODEL_ROUTING_AUTO_ESCALATION !== 'false';
            },
            isLoggingEnabled() {
                return process.env.MODEL_ROUTING_LOG_DECISIONS === 'true';
            },
            getEconomyProvider() {
                return process.env.MODEL_ROUTING_ECONOMY_PROVIDER as AiProviderType | undefined;
            },
            getEconomyModel() {
                return process.env.MODEL_ROUTING_ECONOMY_MODEL;
            },
            getStandardProvider() {
                return process.env.MODEL_ROUTING_STANDARD_PROVIDER as AiProviderType | undefined;
            },
            getStandardModel() {
                return process.env.MODEL_ROUTING_STANDARD_MODEL;
            },
            getPremiumProvider() {
                return process.env.MODEL_ROUTING_PREMIUM_PROVIDER as AiProviderType | undefined;
            },
            getPremiumModel() {
                return process.env.MODEL_ROUTING_PREMIUM_MODEL;
            },
        },
    },

    // Search configuration
    search: {
        getExtractContentService() {
            return (process.env.EXTRACT_CONTENT_SERVICE as 'tavily' | 'local') || 'local';
        },
        getWebSearchService() {
            return (process.env.WEB_SEARCH_SERVICE as 'tavily') || 'tavily';
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

    // Sentry configuration
    sentry: {
        getDsn() {
            return process.env.SENTRY_DSN;
        },
        getProjectId() {
            return process.env.SENTRY_PROJECT_ID;
        },
    },

    // PostHog configuration
    posthog: {
        getApiKey() {
            return process.env.POSTHOG_API_KEY;
        },
        getHost() {
            return process.env.POSTHOG_HOST;
        },
    },

    subscriptions: {
        isEnabled() {
            return process.env.SUBSCRIPTIONS_ENABLED === 'true';
        },
        scheduledUpdatesEnabled() {
            return process.env.SCHEDULED_UPDATES_ENABLED !== 'false';
        },
        getDispatchIntervalMinutes() {
            return parseInt(process.env.SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES || '5');
        },
        getMaxBatch() {
            return parseInt(process.env.SCHEDULED_UPDATES_MAX_BATCH || '25');
        },
        getDefaultPlanCode() {
            return (process.env.SUBSCRIPTIONS_DEFAULT_PLAN as string) || 'free';
        },
        getMaxFailureBeforePause() {
            return parseInt(process.env.SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE || '3');
        },
        getPayPerUsePriceCents() {
            const usd = parseFloat(process.env.PAY_PER_USE_PRICE_USD || '5');
            return Math.max(0, Math.round(usd * 100));
        },
    },

    websiteTemplate: {
        autoUpdateEnabled() {
            return process.env.WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED !== 'false';
        },
        getBetaBranch() {
            return process.env.WEBSITE_TEMPLATE_BETA_BRANCH || 'stage';
        },
    },

    billing: {
        getDefaultCurrency() {
            return process.env.BILLING_DEFAULT_CURRENCY || 'usd';
        },
        stripe: {
            getSecretKey() {
                return process.env.STRIPE_SECRET_KEY;
            },
            getWebhookSecret() {
                return process.env.STRIPE_WEBHOOK_SECRET;
            },
        },
    },

    branding: {
        getAppName() {
            return process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'Ever Works';
        },
        getCompanyOwner() {
            return process.env.COMPANY_OWNER || process.env.NEXT_PUBLIC_COMPANY_OWNER || 'Ever Co.';
        },
        getPlatformWebsite() {
            return (
                process.env.PLATFORM_WEBSITE ||
                process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE ||
                'https://ever.works'
            );
        },
    },
};
