import { describe, it, expect } from 'vitest';
import { AiProviderPromptService } from '../ai-provider-prompt.service';
import { AiProviderRegistryService } from '../../ai-providers/ai-provider-registry.service';

/**
 * The "enter a custom model" hint must only name ids the vendor still serves
 * (models refresh, checked 2026-11-05 on each vendor's model list / live API).
 */
describe('AiProviderPromptService custom model examples', () => {
    const service = new AiProviderPromptService(new AiProviderRegistryService(), {} as never);
    const examples = (provider: string): string =>
        (
            service as unknown as { getCustomModelExamples(p: string): string }
        ).getCustomModelExamples(provider);

    it('names a current model for each hosted vendor', () => {
        expect(examples('openai')).toContain('gpt-6.1-sol');
        expect(examples('google')).toContain('gemini-3.8-flash');
        expect(examples('anthropic')).toContain('claude-sonnet-5-5');
        expect(examples('openrouter')).toContain('anthropic/claude-opus-5.5');
        expect(examples('groq')).toContain('openai/gpt-oss-20b');
        expect(examples('ollama')).toContain('qwen3.5');
    });

    it('names no retired or non-API model id', () => {
        const retired = [
            'o3-mini',
            'gemini-3-pro,',
            'gemini-3-flash,',
            'gemini-2.0-flash',
            'claude-sonnet-4.5',
            'claude-haiku-4.5',
            'claude-3-5-sonnet-latest',
            'google/gemini-3-flash,',
            'llama-3.3-70b-instruct:free',
            'qwen-qwq-32b',
        ];
        for (const provider of ['openai', 'google', 'anthropic', 'openrouter', 'groq']) {
            const text = `${examples(provider)},`;
            for (const id of retired) {
                expect(text, `${provider} example names ${id}`).not.toContain(id);
            }
        }
    });
});
