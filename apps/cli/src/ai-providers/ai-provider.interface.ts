export interface AiProviderDefaults {
    model: string;
    temperature: number;
    maxTokens: number;
    baseUrl?: string;
}

export interface AiProviderInfo {
    name: string;
    displayName: string;
    description: string;
    defaults: AiProviderDefaults;
    requiresApiKey: boolean;
    models: string[];
    websiteUrl: string;
    docsUrl: string;
}

export interface ConfiguredAiProvider {
    name: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    baseUrl?: string;
}

export interface AiProviderConfiguration {
    defaultProvider: string;
    fallbackProviders: string[];
    providers: ConfiguredAiProvider[];
}
