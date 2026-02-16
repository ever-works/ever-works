import {
    fetchOpenRouterModels,
    fuzzyMatchModel,
    extractBaseName,
    type OpenRouterModelEntry,
} from '../openrouter-model-lookup';

describe('openrouter-model-lookup', () => {
    describe('extractBaseName', () => {
        it('should return full string when no slash', () => {
            expect(extractBaseName('gpt-4o')).toBe('gpt-4o');
        });

        it('should return segment after last slash', () => {
            expect(extractBaseName('openai/gpt-4o')).toBe('gpt-4o');
        });

        it('should handle multiple slashes', () => {
            expect(extractBaseName('models/google/gemini-2.5-flash')).toBe('gemini-2.5-flash');
        });

        it('should handle provider prefix like models/', () => {
            expect(extractBaseName('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
        });
    });

    describe('fuzzyMatchModel', () => {
        const candidates: OpenRouterModelEntry[] = [
            { id: 'openai/gpt-4o', context_length: 128000, name: 'GPT-4o' },
            { id: 'openai/gpt-4o-mini', context_length: 128000, name: 'GPT-4o Mini' },
            { id: 'google/gemini-2.5-flash', context_length: 1048576, name: 'Gemini 2.5 Flash' },
            { id: 'qwen/qwen3-32b', context_length: 40960, name: 'Qwen3 32B' },
            { id: 'anthropic/claude-sonnet-4', context_length: 200000, name: 'Claude Sonnet 4' },
            { id: 'openai/gpt-4', context_length: 8192, name: 'GPT-4' },
        ];

        it('should exact-match on full ID', () => {
            const match = fuzzyMatchModel('openai/gpt-4o', candidates);
            expect(match).not.toBeNull();
            expect(match!.id).toBe('openai/gpt-4o');
        });

        it('should match case-insensitively', () => {
            const match = fuzzyMatchModel('OpenAI/GPT-4o', candidates);
            expect(match).not.toBeNull();
            expect(match!.id).toBe('openai/gpt-4o');
        });

        it('should match by base name (qwen3-32b → qwen/qwen3-32b)', () => {
            const match = fuzzyMatchModel('qwen3-32b', candidates);
            expect(match).not.toBeNull();
            expect(match!.id).toBe('qwen/qwen3-32b');
            expect(match!.context_length).toBe(40960);
        });

        it('should match by base name with provider prefix (models/gemini-2.5-flash → google/gemini-2.5-flash)', () => {
            const match = fuzzyMatchModel('models/gemini-2.5-flash', candidates);
            expect(match).not.toBeNull();
            expect(match!.id).toBe('google/gemini-2.5-flash');
            expect(match!.context_length).toBe(1048576);
        });

        it('should match bare model name (gpt-4o → openai/gpt-4o)', () => {
            const match = fuzzyMatchModel('gpt-4o', candidates);
            expect(match).not.toBeNull();
            expect(match!.id).toBe('openai/gpt-4o');
        });

        it('should not produce false positive (gpt-4 must NOT match gpt-4o)', () => {
            const match = fuzzyMatchModel('gpt-4', candidates);
            expect(match).not.toBeNull();
            expect(match!.id).toBe('openai/gpt-4');
            expect(match!.context_length).toBe(8192);
        });

        it('should return null when no match', () => {
            const match = fuzzyMatchModel('nonexistent-model-xyz', candidates);
            expect(match).toBeNull();
        });

        it('should return null for empty candidates', () => {
            const match = fuzzyMatchModel('gpt-4o', []);
            expect(match).toBeNull();
        });

        it('should return null for empty modelId', () => {
            const match = fuzzyMatchModel('', candidates);
            expect(match).toBeNull();
        });

        it('should prefer exact match over base-name match', () => {
            const withDuplicate: OpenRouterModelEntry[] = [
                { id: 'other/gpt-4o', context_length: 64000 },
                { id: 'openai/gpt-4o', context_length: 128000 },
            ];
            const match = fuzzyMatchModel('openai/gpt-4o', withDuplicate);
            expect(match).not.toBeNull();
            expect(match!.id).toBe('openai/gpt-4o');
            expect(match!.context_length).toBe(128000);
        });
    });

    describe('fetchOpenRouterModels', () => {
        const originalFetch = global.fetch;

        afterEach(() => {
            global.fetch = originalFetch;
        });

        it('should return data array on success', async () => {
            const mockData = [
                { id: 'openai/gpt-4o', context_length: 128000 },
                { id: 'google/gemini-2.5-flash', context_length: 1048576 },
            ];

            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: mockData }),
            });

            const result = await fetchOpenRouterModels();
            expect(result).toEqual(mockData);
            expect(global.fetch).toHaveBeenCalledWith(
                'https://openrouter.ai/api/v1/models',
                expect.objectContaining({
                    headers: { Accept: 'application/json' },
                }),
            );
        });

        it('should return null on network error', async () => {
            global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

            const result = await fetchOpenRouterModels();
            expect(result).toBeNull();
        });

        it('should return null on non-200 response', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 500,
            });

            const result = await fetchOpenRouterModels();
            expect(result).toBeNull();
        });

        it('should return null when response has no data array', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ models: [] }),
            });

            const result = await fetchOpenRouterModels();
            expect(result).toBeNull();
        });
    });
});
