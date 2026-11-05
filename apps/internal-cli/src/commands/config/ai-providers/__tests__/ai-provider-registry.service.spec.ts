import { describe, it, expect, beforeEach } from 'vitest';
import { AiProviderRegistryService } from '../ai-provider-registry.service';

describe('AiProviderRegistryService', () => {
    let service: AiProviderRegistryService;

    beforeEach(() => {
        service = new AiProviderRegistryService();
    });

    describe('getAllProviders', () => {
        it('registers exactly the nine default providers', () => {
            const providers = service.getAllProviders();
            expect(providers.map((p) => p.name).sort()).toEqual([
                'anthropic',
                'custom',
                'google',
                'groq',
                'lm-studio',
                'ollama',
                'openai',
                'openrouter',
                'vllm',
            ]);
        });

        it('every provider has a non-empty displayName + description + defaults', () => {
            for (const p of service.getAllProviders()) {
                expect(p.displayName).toBeTruthy();
                expect(p.description).toBeTruthy();
                expect(p.defaults).toBeDefined();
                expect(typeof p.defaults.temperature).toBe('number');
                expect(typeof p.defaults.maxTokens).toBe('number');
                expect(typeof p.defaults.model).toBe('string');
            }
        });
    });

    describe('getProvider', () => {
        it('returns the provider by name', () => {
            expect(service.getProvider('openai')?.displayName).toBe('OpenAI');
            expect(service.getProvider('anthropic')?.displayName).toBe('Anthropic (Claude)');
            expect(service.getProvider('groq')?.displayName).toBe('Groq');
        });

        it('returns undefined for unknown providers', () => {
            expect(service.getProvider('nonexistent')).toBeUndefined();
            expect(service.getProvider('')).toBeUndefined();
        });
    });

    describe('provider properties pinning', () => {
        it('local providers (ollama, lm-studio, vllm) and custom do NOT require an api key by default', () => {
            const noKeyProviders = ['ollama', 'lm-studio', 'vllm', 'custom'];
            for (const name of noKeyProviders) {
                expect(service.getProvider(name)?.requiresApiKey).toBe(false);
            }
            for (const p of service.getAllProviders()) {
                if (noKeyProviders.includes(p.name)) continue;
                expect(p.requiresApiKey).toBe(true);
            }
        });

        it('ollama defaults include the localhost baseUrl', () => {
            expect(service.getProvider('ollama')?.defaults.baseUrl).toBe(
                'http://localhost:11434/v1',
            );
        });

        it('custom provider has empty models array (open-ended)', () => {
            expect(service.getProvider('custom')?.models).toEqual([]);
        });

        // The anthropic default used to be `claude-3-5-sonnet-latest`, which the
        // Claude API retired on 2025-10-28, so `config` wrote a model every
        // request then failed on. Active ids, from the vendor's docs on 2026-10-28:
        // https://platform.claude.com/docs/en/about-claude/model-deprecations
        it('anthropic defaults to an active Claude API model id that its own picker offers', () => {
            const anthropic = service.getProvider('anthropic')!;
            expect([
                'claude-fable-5-1',
                'claude-fable-5',
                'claude-opus-5-5',
                'claude-opus-5',
                'claude-opus-4-8',
                'claude-opus-4-7',
                'claude-opus-4-6',
                'claude-opus-4-5-20251101',
                'claude-sonnet-5-5',
                'claude-sonnet-5',
                'claude-sonnet-4-6',
                'claude-haiku-5-5',
                'claude-haiku-4-5-20251001',
            ]).toContain(anthropic.defaults.model);
            expect(anthropic.models).toContain(anthropic.defaults.model);
        });

        // Models refresh (checked 2026-11-05 on each vendor's model list / live API;
        // sheet: homelab projects/ever-works/knowledge/notes/2026-09-17-app-works/
        // handover-2026-09-26/models-refresh-source-sheet-2026-11-05.md).
        it('defaults each hosted provider to the vendor current model', () => {
            expect(service.getProvider('openai')?.defaults.model).toBe('gpt-6.1-sol');
            expect(service.getProvider('google')?.defaults.model).toBe('gemini-3.8-flash');
            expect(service.getProvider('anthropic')?.defaults.model).toBe('claude-opus-5-5');
            expect(service.getProvider('openrouter')?.defaults.model).toBe('openai/gpt-6.1-sol');
            expect(service.getProvider('groq')?.defaults.model).toBe('openai/gpt-oss-120b');
            expect(service.getProvider('ollama')?.defaults.model).toBe('qwen3.5');
        });

        it('offers each provider default in its own picker', () => {
            for (const p of service.getAllProviders()) {
                // lm-studio / vllm / custom default to whatever the local server loaded.
                if (['lm-studio', 'vllm', 'custom'].includes(p.name)) continue;
                expect(p.models).toContain(p.defaults.model);
            }
        });

        it('offers the current flagship of each hosted vendor', () => {
            expect(service.getProvider('openai')?.models).toEqual(
                expect.arrayContaining([
                    'gpt-6-astra',
                    'gpt-6.1-sol',
                    'gpt-6.1-terra',
                    'gpt-6-luna',
                ]),
            );
            expect(service.getProvider('google')?.models).toEqual(
                expect.arrayContaining([
                    'gemini-4-argon',
                    'gemini-3.8-flash',
                    'gemini-3.5-flash-lite',
                ]),
            );
            expect(service.getProvider('anthropic')?.models).toEqual(
                expect.arrayContaining([
                    'claude-opus-5-5',
                    'claude-sonnet-5-5',
                    'claude-haiku-5-5',
                    'claude-fable-5-1',
                ]),
            );
            expect(service.getProvider('openrouter')?.models).toEqual(
                expect.arrayContaining([
                    'openai/gpt-6-astra',
                    'anthropic/claude-opus-5.5',
                    'google/gemini-4-argon',
                    'x-ai/grok-4.7',
                ]),
            );
            expect(service.getProvider('groq')?.models).toEqual(
                expect.arrayContaining(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']),
            );
        });

        it('offers no retired or non-API model id', () => {
            const retired = [
                // OpenAI: retired 2026-10-23 / 2025-10-27.
                'o3-mini',
                'o1-mini',
                // Gemini API: shut down, or never Gemini API ids.
                'gemini-2.0-flash',
                'gemini-3-pro',
                'gemini-3-flash',
                // Claude API: retired snapshots/aliases, and dotted names that were never API ids.
                'claude-3-5-sonnet-latest',
                'claude-3-5-haiku-latest',
                'claude-3-haiku-20240307',
                'claude-sonnet-4.5',
                'claude-haiku-4.5',
                // Groq: retired (console.groq.com/docs/deprecations).
                'qwen/qwen3-32b',
                'llama-3.3-70b-specdec',
                'llama-3.2-90b-vision-preview',
                'qwen-qwq-32b',
                'qwen-2.5-coder-32b',
                'deepseek-r1-distill-qwen-32b',
                // OpenRouter: absent from https://openrouter.ai/api/v1/models.
                'google/gemini-3-flash',
                'google/gemini-2.0-flash-001',
                'meta-llama/llama-3.3-70b-instruct:free',
                'deepseek/deepseek-r1',
                'x-ai/grok-3-mini-beta',
            ];
            for (const p of service.getAllProviders()) {
                for (const id of retired) {
                    expect(p.models, `${p.name} offers ${id}`).not.toContain(id);
                    expect(p.defaults.model).not.toBe(id);
                }
            }
        });

        it('every non-custom provider has at least one model in its catalog', () => {
            for (const p of service.getAllProviders()) {
                if (p.name === 'custom') continue;
                expect(p.models.length).toBeGreaterThan(0);
            }
        });
    });

    describe('getProviderChoices', () => {
        it('returns one inquirer-shaped choice per provider', () => {
            const choices = service.getProviderChoices();
            expect(choices.length).toBe(service.getAllProviders().length);
            for (const c of choices) {
                expect(c).toHaveProperty('name');
                expect(c).toHaveProperty('value');
            }
        });

        it('includes the displayName + " - " + description in each choice name', () => {
            const choices = service.getProviderChoices();
            const openAi = choices.find((c) => c.value === 'openai');
            expect(openAi?.name).toBe('OpenAI - OpenAI GPT models (GPT-6, GPT-6.1, GPT-5.x)');
        });
    });

    describe('getProviderChoicesWithIgnore', () => {
        it('appends an "ignore" option after the regular choices', () => {
            const choices = service.getProviderChoicesWithIgnore();
            expect(choices.length).toBe(service.getAllProviders().length + 1);
            const last = choices[choices.length - 1];
            expect(last).toEqual({ name: 'Skip AI configuration', value: 'ignore' });
        });

        it('does not mutate the result of getProviderChoices on subsequent calls', () => {
            // The service's underlying map is shared, but each call should re-derive the array
            const a = service.getProviderChoices();
            const aLen = a.length;
            service.getProviderChoicesWithIgnore();
            const b = service.getProviderChoices();
            expect(b.length).toBe(aLen);
            expect(b.find((c) => c.value === 'ignore')).toBeUndefined();
        });
    });
});
