import { Injectable } from '@nestjs/common';

interface AiProviderDefaults {
    model: string;
    temperature: number;
    maxTokens: number;
    baseUrl?: string;
}

interface AiProviderInfo {
    name: string;
    displayName: string;
    description: string;
    defaults: AiProviderDefaults;
    requiresApiKey: boolean;
    models: string[];
    websiteUrl: string;
    docsUrl: string;
}

@Injectable()
export class AiProviderRegistryService {
    private readonly providers: Map<string, AiProviderInfo> = new Map();

    constructor() {
        this.registerDefaultProviders();
    }

    private registerDefaultProviders(): void {
        this.providers.set('openai', {
            name: 'openai',
            displayName: 'OpenAI',
            description: 'OpenAI GPT models (GPT-5, GPT-4o, o1/o3)',
            defaults: {
                model: 'gpt-4o',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'gpt-5.2',
                'gpt-5.1',
                'gpt-5',
                'gpt-5-mini',
                'gpt-5-nano',
                'gpt-4o',
                'gpt-4o-mini',
                'o3-mini',
                'o1-mini',
            ],
            websiteUrl: 'https://openai.com',
            docsUrl: 'https://platform.openai.com/docs',
        });

        this.providers.set('google', {
            name: 'google',
            displayName: 'Google AI (Gemini)',
            description: 'Google Gemini models (Gemini 3, 2.5, 2.0)',
            defaults: {
                model: 'gemini-2.0-flash',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'gemini-3-pro',
                'gemini-3-flash',
                'gemini-2.5-pro',
                'gemini-2.5-flash',
                'gemini-2.0-flash',
            ],
            websiteUrl: 'https://ai.google.dev',
            docsUrl: 'https://ai.google.dev/docs',
        });

        this.providers.set('anthropic', {
            name: 'anthropic',
            displayName: 'Anthropic (Claude)',
            description: 'Anthropic Claude models (Claude 4.5, 3.5)',
            defaults: {
                model: 'claude-3-5-sonnet-latest',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'claude-opus-4-5-20251101',
                'claude-sonnet-4.5',
                'claude-haiku-4.5',
                'claude-3-5-sonnet-latest',
                'claude-3-5-haiku-latest',
                'claude-3-haiku-20240307',
            ],
            websiteUrl: 'https://anthropic.com',
            docsUrl: 'https://docs.anthropic.com',
        });

        this.providers.set('openrouter', {
            name: 'openrouter',
            displayName: 'OpenRouter',
            description: 'Access to 400+ AI models through OpenRouter',
            defaults: {
                model: 'openai/gpt-4o',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'openai/gpt-5.2',
                'openai/gpt-5.1',
                'openai/gpt-5-mini',
                'openai/gpt-5-nano',
                'openai/gpt-4o',
                'anthropic/claude-opus-4.5',
                'moonshotai/kimi-k2.5',
                'google/gemini-3-flash',
                'google/gemini-2.0-flash-001',
                'meta-llama/llama-3.3-70b-instruct',
                'meta-llama/llama-3.3-70b-instruct:free',
                'deepseek/deepseek-r1',
                'x-ai/grok-3-mini-beta',
            ],
            websiteUrl: 'https://openrouter.ai',
            docsUrl: 'https://openrouter.ai/docs',
        });

        this.providers.set('ollama', {
            name: 'ollama',
            displayName: 'Ollama',
            description: 'Local AI models through Ollama (free)',
            defaults: {
                model: 'llama3.3',
                temperature: 0.7,
                maxTokens: 8192,
                baseUrl: 'http://localhost:11434/v1',
            },
            requiresApiKey: false,
            models: [
                'llama3.3',
                'llama3.2',
                'qwen2.5',
                'qwen2.5-coder',
                'deepseek-r1',
                'deepseek-coder-v2',
                'gemma2',
                'phi4',
            ],
            websiteUrl: 'https://ollama.ai',
            docsUrl: 'https://github.com/ollama/ollama',
        });

        // Groq
        this.providers.set('groq', {
            name: 'groq',
            displayName: 'Groq',
            description: 'Ultra-fast inference with Groq LPU',
            defaults: {
                model: 'openai/gpt-oss-120b',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'openai/gpt-oss-120b',
                'llama-3.3-70b-versatile',
                'llama-3.3-70b-specdec',
                'llama-3.1-8b-instant',
                'llama-3.2-90b-vision-preview',
                'qwen-qwq-32b',
                'qwen-2.5-coder-32b',
                'deepseek-r1-distill-qwen-32b',
            ],
            websiteUrl: 'https://groq.com',
            docsUrl: 'https://console.groq.com/docs',
        });

        // Custom OpenAI-compatible provider
        this.providers.set('custom', {
            name: 'custom',
            displayName: 'Custom (OpenAI-compatible)',
            description: 'Any OpenAI-compatible API endpoint',
            defaults: {
                model: 'default',
                temperature: 0.7,
                maxTokens: 8192,
                baseUrl: '',
            },
            requiresApiKey: false,
            models: [],
            websiteUrl: '',
            docsUrl: 'https://platform.openai.com/docs/api-reference',
        });
    }

    /**
     * Get all available providers
     */
    getAllProviders(): AiProviderInfo[] {
        return Array.from(this.providers.values());
    }

    /**
     * Get provider by name
     */
    getProvider(name: string): AiProviderInfo | undefined {
        return this.providers.get(name);
    }

    /**
     * Get provider choices for inquirer
     */
    getProviderChoices(): Array<{ name: string; value: string }> {
        return this.getAllProviders().map((provider) => ({
            name: `${provider.displayName} - ${provider.description}`,
            value: provider.name,
        }));
    }

    /**
     * Get provider choices with ignore option
     */
    getProviderChoicesWithIgnore(): Array<{ name: string; value: string }> {
        const choices = this.getProviderChoices();
        choices.push({ name: 'Skip AI configuration', value: 'ignore' });
        return choices;
    }
}
