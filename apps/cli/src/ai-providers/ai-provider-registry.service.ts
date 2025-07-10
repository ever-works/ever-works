import { Injectable } from '@nestjs/common';
import { AiProviderInfo } from '@packages/agent';

@Injectable()
export class AiProviderRegistryService {
    private readonly providers: Map<string, AiProviderInfo> = new Map();

    constructor() {
        this.registerDefaultProviders();
    }

    private registerDefaultProviders(): void {
        // OpenAI
        this.providers.set('openai', {
            name: 'openai',
            displayName: 'OpenAI',
            description: 'OpenAI GPT models (GPT-4, GPT-3.5, etc.)',
            defaults: {
                model: 'gpt-4.1',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
            websiteUrl: 'https://openai.com',
            docsUrl: 'https://platform.openai.com/docs',
        });

        // Google AI (Gemini)
        this.providers.set('google', {
            name: 'google',
            displayName: 'Google AI (Gemini)',
            description: 'Google Gemini models',
            defaults: {
                model: 'gemini-2.5-flash',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
            websiteUrl: 'https://ai.google.dev',
            docsUrl: 'https://ai.google.dev/docs',
        });

        // Anthropic (Claude)
        this.providers.set('anthropic', {
            name: 'anthropic',
            displayName: 'Anthropic (Claude)',
            description: 'Anthropic Claude models',
            defaults: {
                model: 'claude-3-5-sonnet-20241022',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'claude-3-5-sonnet-20241022',
                'claude-3-opus-20240229',
                'claude-3-sonnet-20240229',
                'claude-3-haiku-20240307',
            ],
            websiteUrl: 'https://anthropic.com',
            docsUrl: 'https://docs.anthropic.com',
        });

        // OpenRouter
        this.providers.set('openrouter', {
            name: 'openrouter',
            displayName: 'OpenRouter',
            description: 'Access to multiple AI models through OpenRouter',
            defaults: {
                model: 'openai/gpt-4.1',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'openai/gpt-4.1',
                'openai/gpt-4',
                'anthropic/claude-3-5-sonnet',
                'google/gemini-2.5-flash',
                'meta-llama/llama-3.1-70b-instruct',
            ],
            websiteUrl: 'https://openrouter.ai',
            docsUrl: 'https://openrouter.ai/docs',
        });

        // Ollama
        this.providers.set('ollama', {
            name: 'ollama',
            displayName: 'Ollama',
            description: 'Local AI models through Ollama',
            defaults: {
                model: 'llama2',
                temperature: 0.7,
                maxTokens: 8192,
                baseUrl: 'http://localhost:11434/v1',
            },
            requiresApiKey: false,
            models: ['llama2', 'llama3', 'codellama', 'mistral', 'neural-chat'],
            websiteUrl: 'https://ollama.ai',
            docsUrl: 'https://github.com/ollama/ollama',
        });

        // Mistral AI
        this.providers.set('mistral', {
            name: 'mistral',
            displayName: 'Mistral AI',
            description: 'Mistral AI models',
            defaults: {
                model: 'mistral-large-latest',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'mistral-large-latest',
                'mistral-medium-latest',
                'mistral-small-latest',
                'open-mistral-7b',
            ],
            websiteUrl: 'https://mistral.ai',
            docsUrl: 'https://docs.mistral.ai',
        });

        // DeepSeek
        this.providers.set('deepseek', {
            name: 'deepseek',
            displayName: 'DeepSeek',
            description: 'DeepSeek AI models',
            defaults: {
                model: 'deepseek-chat',
                temperature: 0.7,
                maxTokens: 8192,
                baseUrl: 'https://api.deepseek.com',
            },
            requiresApiKey: true,
            models: ['deepseek-chat', 'deepseek-coder'],
            websiteUrl: 'https://deepseek.com',
            docsUrl: 'https://platform.deepseek.com/api-docs',
        });

        // Groq
        this.providers.set('groq', {
            name: 'groq',
            displayName: 'Groq',
            description: 'Fast inference with Groq',
            defaults: {
                model: 'llama-3.1-70b-versatile',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'llama-3.1-70b-versatile',
                'llama-3.1-8b-instant',
                'mixtral-8x7b-32768',
                'gemma-7b-it',
            ],
            websiteUrl: 'https://groq.com',
            docsUrl: 'https://console.groq.com/docs',
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
