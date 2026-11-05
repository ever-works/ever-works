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

    /**
     * Model ids and defaults checked 2026-11-05 on each vendor's own model list or
     * live model-list API (models refresh; sheet in the homelab repo,
     * projects/ever-works/knowledge/notes/2026-09-17-app-works/handover-2026-09-26/
     * models-refresh-source-sheet-2026-11-05.md). Retired ids are dropped; ids the
     * vendor still serves stay after the current ones. Any other id can still be
     * entered as a custom model.
     */
    private registerDefaultProviders(): void {
        this.providers.set('openai', {
            name: 'openai',
            displayName: 'OpenAI',
            description: 'OpenAI GPT models (GPT-6, GPT-6.1, GPT-5.x)',
            defaults: {
                // https://developers.openai.com/api/docs/models: "GPT-6.1 Sol to
                // balance intelligence and cost".
                model: 'gpt-6.1-sol',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'gpt-6-astra',
                'gpt-6.1-sol',
                'gpt-6.1-terra',
                'gpt-6-luna',
                'gpt-6-sol',
                'gpt-5.6-sol',
                'gpt-5.6-terra',
                'gpt-5.6-luna',
                'gpt-5.5',
                'gpt-5.4',
                'gpt-5.4-mini',
                'gpt-5.2',
                // Deprecated, still served until their shutdown dates
                // (https://developers.openai.com/api/docs/deprecations).
                'gpt-5.1',
                'gpt-5',
                'gpt-5-mini',
                'gpt-5-nano',
                'gpt-4o',
                'gpt-4o-mini',
            ],
            websiteUrl: 'https://openai.com',
            docsUrl: 'https://platform.openai.com/docs',
        });

        this.providers.set('google', {
            name: 'google',
            displayName: 'Google AI (Gemini)',
            description: 'Google Gemini models (Gemini 4, 3.x, 2.5)',
            defaults: {
                // https://aistudio.google.com/docs/changelog (2026-09-18): new
                // projects should use "3.5 Flash-Lite or 3.8 Flash".
                model: 'gemini-3.8-flash',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'gemini-4-argon',
                'gemini-3.8-flash',
                'gemini-3.6-flash',
                'gemini-3.5-flash-lite',
                'gemini-3.1-pro-preview',
                'gemini-3-flash-preview',
                // Deprecated 2026-11-02: existing users only.
                'gemini-2.5-pro',
                'gemini-2.5-flash',
            ],
            websiteUrl: 'https://ai.google.dev',
            docsUrl: 'https://ai.google.dev/docs',
        });

        this.providers.set('anthropic', {
            name: 'anthropic',
            displayName: 'Anthropic (Claude)',
            description: 'Anthropic Claude models (Claude 5.5, Fable)',
            defaults: {
                // Active Claude API id (the vendor's recommended starting model, checked
                // 2026-10-28). The old default, claude-3-5-sonnet-latest, is retired.
                model: 'claude-opus-5-5',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            models: [
                'claude-opus-5-5',
                'claude-sonnet-5-5',
                'claude-haiku-5-5',
                'claude-fable-5-1',
                // Legacy, still served.
                'claude-opus-4-5-20251101',
                'claude-haiku-4-5-20251001',
                // Deprecated; retires 2026-11-30 (successor claude-sonnet-5-5).
                'claude-sonnet-4-5-20250929',
            ],
            websiteUrl: 'https://anthropic.com',
            docsUrl: 'https://docs.anthropic.com',
        });

        this.providers.set('openrouter', {
            name: 'openrouter',
            displayName: 'OpenRouter',
            description: 'Access to 400+ AI models through OpenRouter',
            defaults: {
                // Same default as the openrouter plugin.
                model: 'openai/gpt-6.1-sol',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            // Ids present on https://openrouter.ai/api/v1/models on 2026-11-05.
            models: [
                'openai/gpt-6-astra',
                'openai/gpt-6.1-sol',
                'openai/gpt-6.1-terra',
                'openai/gpt-6-luna',
                'anthropic/claude-opus-5.5',
                'anthropic/claude-sonnet-5.5',
                'anthropic/claude-haiku-5.5',
                'anthropic/claude-fable-5.1',
                'google/gemini-4-argon',
                'google/gemini-3.8-flash',
                'google/gemini-3.5-flash-lite',
                'x-ai/grok-4.7',
                'x-ai/grok-4.3',
                'mistralai/mistral-large-4-0',
                'deepseek/deepseek-v4-pro',
                'deepseek/deepseek-v4.1-flash',
                'moonshotai/kimi-k3',
                'qwen/qwen3.8-flash',
                'z-ai/glm-5.3',
                'meta-llama/llama-4-maverick',
                // Older ids still listed.
                'openai/gpt-5.2',
                'openai/gpt-5.1',
                'openai/gpt-5-mini',
                'openai/gpt-5-nano',
                'openai/gpt-4o',
                'anthropic/claude-opus-4.5',
                'moonshotai/kimi-k2.5',
                'meta-llama/llama-3.3-70b-instruct',
            ],
            websiteUrl: 'https://openrouter.ai',
            docsUrl: 'https://openrouter.ai/docs',
        });

        this.providers.set('ollama', {
            name: 'ollama',
            displayName: 'Ollama',
            description: 'Local AI models through Ollama (free)',
            defaults: {
                // https://ollama.com/library/qwen3.5 (tools capable; the bare name
                // pulls the latest tag). The ollama plugin defaults to the smaller
                // qwen3.5:4b tag.
                model: 'qwen3.5',
                temperature: 0.7,
                maxTokens: 8192,
                baseUrl: 'http://localhost:11434/v1',
            },
            requiresApiKey: false,
            models: [
                'qwen3.5',
                'gemma4',
                'qwen3',
                'gpt-oss',
                'qwen3-coder',
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

        this.providers.set('lm-studio', {
            name: 'lm-studio',
            displayName: 'LM Studio',
            description: 'Local AI models through LM Studio (free)',
            defaults: {
                model: 'local-model',
                temperature: 0.7,
                maxTokens: 4096,
                baseUrl: 'http://localhost:1234/v1',
            },
            requiresApiKey: false,
            models: [
                'qwen2.5-7b-instruct',
                'llama-3.2-3b-instruct',
                'mistral-7b-instruct',
                'gemma-2-9b-it',
                'phi-4',
            ],
            websiteUrl: 'https://lmstudio.ai',
            docsUrl: 'https://lmstudio.ai/docs',
        });

        this.providers.set('vllm', {
            name: 'vllm',
            displayName: 'vLLM',
            description: 'Self-hosted high-throughput inference via vLLM',
            defaults: {
                model: 'local-model',
                temperature: 0.7,
                maxTokens: 4096,
                baseUrl: 'http://localhost:8000/v1',
            },
            requiresApiKey: false,
            models: [
                'meta-llama/Llama-3.1-8B-Instruct',
                'Qwen/Qwen2.5-7B-Instruct',
                'mistralai/Mistral-7B-Instruct-v0.3',
            ],
            websiteUrl: 'https://docs.vllm.ai',
            docsUrl: 'https://docs.vllm.ai',
        });

        // Groq
        this.providers.set('groq', {
            name: 'groq',
            displayName: 'Groq',
            description: 'Ultra-fast inference with Groq LPU',
            defaults: {
                // qwen/qwen3-32b was retired 2026-07-17; Groq names gpt-oss-120b
                // as its replacement (https://console.groq.com/docs/deprecations).
                model: 'openai/gpt-oss-120b',
                temperature: 0.7,
                maxTokens: 8192,
            },
            requiresApiKey: true,
            // https://console.groq.com/docs/models (2026-11-05).
            models: [
                'openai/gpt-oss-120b',
                'openai/gpt-oss-20b',
                'qwen/qwen3.8-27b',
                // Enterprise plans only since 2026-08-16.
                'llama-3.3-70b-versatile',
                'llama-3.1-8b-instant',
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
