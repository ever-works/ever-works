export interface AiProviderConfig {
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    baseUrl?: string;
}

export interface AiProvidersConfig {
    openai?: AiProviderConfig;
    google?: AiProviderConfig;
    anthropic?: AiProviderConfig;
    openrouter?: AiProviderConfig;
    ollama?: AiProviderConfig;
    mistral?: AiProviderConfig;
    deepseek?: AiProviderConfig;
    groq?: AiProviderConfig;
}

export interface DeploymentProvidersConfig {
    vercel?: {
        token: string;
    };
}

export interface SearchServicesConfig {
    extractContentService: 'tavily' | 'naive';
    webSearchService: 'tavily' | 'google-sr';
    tavilyApiKey?: string;
}

export interface EverWorksConfig {
    // GitHub Configuration
    githubApiKey: string;
    githubOwner: string;
    
    // Git Configuration
    gitName: string;
    gitEmail: string;
    
    // Deployment Providers
    deploymentProviders: DeploymentProvidersConfig;
    
    // AI Configuration
    aiDefaultProvider: string;
    aiFallbackProviders: string[];
    aiProviders: AiProvidersConfig;
    
    // Search Services
    searchServices: SearchServicesConfig;
    
    // App Type
    appType: 'cli' | 'api' | 'test';
}

export interface SetupPromptAnswers {
    githubApiKey: string;
    githubOwner: string;
    gitName: string;
    gitEmail: string;
    deploymentProvider: 'vercel' | 'ignore';
    vercelToken?: string;
    aiDefaultProvider: string;
    aiFallbackProviders: string[];
    extractContentService: 'tavily' | 'naive';
    webSearchService: 'tavily' | 'google-sr';
    tavilyApiKey?: string;
}
