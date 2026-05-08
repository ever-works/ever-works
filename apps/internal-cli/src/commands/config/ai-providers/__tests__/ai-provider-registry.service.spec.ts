import { describe, it, expect, beforeEach } from 'vitest';
import { AiProviderRegistryService } from '../ai-provider-registry.service';

describe('AiProviderRegistryService', () => {
    let service: AiProviderRegistryService;

    beforeEach(() => {
        service = new AiProviderRegistryService();
    });

    describe('getAllProviders', () => {
        it('registers exactly the seven default providers', () => {
            const providers = service.getAllProviders();
            expect(providers.map((p) => p.name).sort()).toEqual([
                'anthropic',
                'custom',
                'google',
                'groq',
                'ollama',
                'openai',
                'openrouter',
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
        it('ollama is the only provider that does NOT require an api key by default', () => {
            const ollama = service.getProvider('ollama');
            const custom = service.getProvider('custom');
            expect(ollama?.requiresApiKey).toBe(false);
            // custom is also requiresApiKey:false; ollama and custom should both be flagged
            expect(custom?.requiresApiKey).toBe(false);
            for (const p of service.getAllProviders()) {
                if (p.name === 'ollama' || p.name === 'custom') continue;
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
            expect(openAi?.name).toBe('OpenAI - OpenAI GPT models (GPT-5, GPT-4o, o1/o3)');
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
