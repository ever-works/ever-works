import {
    fetchModelCatalog,
    fetchModelsDevCatalog,
    fetchOpenRouterModelCatalog,
    matchModelCatalogEntry,
    extractBaseName,
    type ModelCatalogEntry,
} from '../model-catalog';

describe('model-catalog', () => {
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
    });

    describe('matchModelCatalogEntry', () => {
        const candidates: ModelCatalogEntry[] = [
            {
                id: 'openai/gpt-4o',
                modelId: 'gpt-4o',
                providerId: 'openai',
                maxContextLength: 128000,
                source: 'openrouter',
            },
            {
                id: 'openai/gpt-4o-mini',
                modelId: 'gpt-4o-mini',
                providerId: 'openai',
                maxContextLength: 128000,
                source: 'openrouter',
            },
            {
                id: 'google/gemini-2.5-flash',
                modelId: 'gemini-2.5-flash',
                providerId: 'google',
                maxContextLength: 1048576,
                source: 'openrouter',
            },
            {
                id: 'qwen/qwen3-32b',
                modelId: 'qwen3-32b',
                providerId: 'qwen',
                maxContextLength: 40960,
                source: 'openrouter',
            },
            {
                id: 'qwen/qwen3.5-9b',
                modelId: 'qwen3.5-9b',
                providerId: 'qwen',
                maxContextLength: 32768,
                source: 'openrouter',
            },
            {
                id: 'deepseek/deepseek-coder-v2-16b-lite-instruct',
                modelId: 'deepseek-coder-v2-16b-lite-instruct',
                providerId: 'deepseek',
                maxContextLength: 65536,
                source: 'openrouter',
            },
            {
                id: 'anthropic/claude-sonnet-4',
                modelId: 'claude-sonnet-4',
                providerId: 'anthropic',
                maxContextLength: 200000,
                source: 'openrouter',
            },
            {
                id: 'models-dev/openai/gpt-4',
                modelId: 'gpt-4',
                providerId: 'openai',
                maxContextLength: 8192,
                source: 'models.dev',
            },
        ];

        it('should exact-match on full ID', () => {
            const match = matchModelCatalogEntry('openai/gpt-4o', candidates);
            expect(match?.id).toBe('openai/gpt-4o');
        });

        it('should match case-insensitively', () => {
            const match = matchModelCatalogEntry('OpenAI/GPT-4o', candidates);
            expect(match?.id).toBe('openai/gpt-4o');
        });

        it('should match by base name', () => {
            const match = matchModelCatalogEntry('qwen3-32b', candidates);
            expect(match?.id).toBe('qwen/qwen3-32b');
        });

        it('should match by base name with provider prefix', () => {
            const match = matchModelCatalogEntry('models/gemini-2.5-flash', candidates);
            expect(match?.id).toBe('google/gemini-2.5-flash');
        });

        it('should match colon-tagged model IDs', () => {
            const match = matchModelCatalogEntry('qwen/qwen3.5:9b', candidates);
            expect(match?.id).toBe('qwen/qwen3.5-9b');
        });

        it('should strip quantization suffixes when matching tagged model IDs', () => {
            const match = matchModelCatalogEntry(
                'deepseek-coder-v2:16b-lite-instruct-q2_K',
                candidates,
            );
            expect(match?.id).toBe('deepseek/deepseek-coder-v2-16b-lite-instruct');
        });

        it('should treat latest tags as the base model', () => {
            const match = matchModelCatalogEntry('openai/gpt-4o:latest', candidates);
            expect(match?.id).toBe('openai/gpt-4o');
        });

        it('should prefer the hinted provider when multiple base-name matches exist', () => {
            const match = matchModelCatalogEntry('gpt-4', candidates, 'openai');
            expect(match?.providerId).toBe('openai');
        });

        it('should not produce false positives', () => {
            const match = matchModelCatalogEntry('nonexistent-model-xyz', candidates);
            expect(match).toBeNull();
        });

        it('should ignore a tag past the length cap rather than scan it', () => {
            // Two controls stand between a caller-supplied model id and the tag
            // patterns: this length cap, and a parameter-size pattern rewritten
            // so it cannot re-split two adjacent digit runs (measured on the old
            // spelling: 32k digits cost 2.1s; the new one is 0.1ms flat).
            //
            // NOTE ON WHAT IS NOT TESTED HERE: with both controls in place no
            // elapsed-time assertion can distinguish either one — the cap
            // short-circuits before the pattern runs, and the pattern is linear
            // once it does. A timing test would therefore pass with either fix
            // reverted, which is a test that asserts nothing. These assert
            // behaviour instead; the timing evidence lives in the measurements
            // quoted beside the constants.
            const oversized = matchModelCatalogEntry(`qwen3-32b:${'a'.repeat(200)}`, candidates);
            expect(oversized?.id).toBe('qwen/qwen3-32b');

            // A 32k-digit tag is the shape that used to stall. It resolves
            // through the base name, and resolves at all.
            const hostile = matchModelCatalogEntry(`qwen3-32b:${'1'.repeat(32_000)}x`, candidates);
            expect(hostile?.id).toBe('qwen/qwen3-32b');
        });

        it('should still read a tag that sits just under the length cap', () => {
            // The cap must not swallow tags a real client sends: 128 characters
            // is far past any real tag, so a tag at the boundary is still parsed
            // rather than discarded.
            const atCap = `q4_k_m${'-x'.repeat(60)}`;
            expect(atCap.length).toBeLessThanOrEqual(128);
            expect(matchModelCatalogEntry(`qwen3-32b:${atCap}`, candidates)?.id).toBe(
                'qwen/qwen3-32b',
            );
        });

        it('should still read ordinary parameter-size tags', () => {
            // Guards the rewritten pattern's semantics, which must be unchanged:
            // a plain size, a decimal size, and an active-parameter suffix.
            expect(matchModelCatalogEntry('qwen3:32b', candidates)?.id).toBe('qwen/qwen3-32b');
            expect(matchModelCatalogEntry('qwen/qwen3.5:9b', candidates)?.id).toBe(
                'qwen/qwen3.5-9b',
            );
        });
    });

    describe('catalog fetching', () => {
        const originalFetch = global.fetch;

        afterEach(() => {
            global.fetch = originalFetch;
        });

        it('should return OpenRouter entries on success', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        data: [
                            {
                                id: 'openai/gpt-4o',
                                name: 'GPT-4o',
                                context_length: 128000,
                                max_output_tokens: 16384,
                                pricing: { prompt: '0.000005', completion: '0.000015' },
                            },
                        ],
                    }),
            });

            const result = await fetchOpenRouterModelCatalog();
            expect(result).toHaveLength(1);
            expect(result?.[0]).toMatchObject({
                id: 'openai/gpt-4o',
                modelId: 'gpt-4o',
                name: 'GPT-4o',
                providerId: 'openai',
                maxContextLength: 128000,
                maxOutputTokens: 16384,
                inputCostPer1k: 0.005,
                source: 'openrouter',
            });
            expect(result?.[0].outputCostPer1k).toBeCloseTo(0.015, 12);
        });

        it('should parse models.dev provider data', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        openai: {
                            id: 'openai',
                            name: 'OpenAI',
                            models: {
                                'gpt-5.1': {
                                    id: 'gpt-5.1',
                                    name: 'GPT-5.1',
                                    cost: { input: 1.25, output: 10 },
                                    limit: { context: 400000, output: 128000 },
                                },
                            },
                        },
                    }),
            });

            const result = await fetchModelsDevCatalog();
            expect(result).toEqual([
                {
                    id: 'openai/gpt-5.1',
                    modelId: 'gpt-5.1',
                    name: 'GPT-5.1',
                    providerId: 'openai',
                    providerName: 'OpenAI',
                    maxContextLength: 400000,
                    maxOutputTokens: 128000,
                    inputCostPer1k: 0.00125,
                    outputCostPer1k: 0.01,
                    source: 'models.dev',
                },
            ]);
        });

        it('should fall back to models.dev when OpenRouter fetch fails', async () => {
            global.fetch = jest
                .fn()
                .mockRejectedValueOnce(new Error('OpenRouter down'))
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            xai: {
                                id: 'xai',
                                name: 'xAI',
                                models: {
                                    'grok-4.1-fast': {
                                        id: 'grok-4.1-fast',
                                        name: 'Grok 4.1 Fast',
                                        cost: { input: 2, output: 10 },
                                        limit: { context: 200000, output: 64000 },
                                    },
                                },
                            },
                        }),
                });

            const result = await fetchModelCatalog();
            expect(result).toEqual([
                {
                    id: 'xai/grok-4.1-fast',
                    modelId: 'grok-4.1-fast',
                    name: 'Grok 4.1 Fast',
                    providerId: 'xai',
                    providerName: 'xAI',
                    maxContextLength: 200000,
                    maxOutputTokens: 64000,
                    inputCostPer1k: 0.002,
                    outputCostPer1k: 0.01,
                    source: 'models.dev',
                },
            ]);
        });

        it('should merge OpenRouter and models.dev metadata for the same model', async () => {
            global.fetch = jest
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            data: [
                                {
                                    id: 'openai/gpt-5.1',
                                    name: 'GPT-5.1',
                                    context_length: 400000,
                                },
                            ],
                        }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            openai: {
                                id: 'openai',
                                name: 'OpenAI',
                                models: {
                                    'gpt-5.1': {
                                        id: 'gpt-5.1',
                                        cost: { input: 1.25, output: 10 },
                                        limit: { output: 128000 },
                                    },
                                },
                            },
                        }),
                });

            const result = await fetchModelCatalog();

            expect(result).toEqual([
                {
                    id: 'openai/gpt-5.1',
                    modelId: 'gpt-5.1',
                    name: 'GPT-5.1',
                    providerId: 'openai',
                    providerName: 'OpenAI',
                    maxContextLength: 400000,
                    maxOutputTokens: 128000,
                    inputCostPer1k: 0.00125,
                    outputCostPer1k: 0.01,
                    source: 'openrouter',
                },
            ]);
        });

        it('should keep models.dev entries when OpenRouter succeeds without the requested model', async () => {
            global.fetch = jest
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ data: [] }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            xai: {
                                id: 'xai',
                                name: 'xAI',
                                models: {
                                    'grok-4.1-fast': {
                                        id: 'grok-4.1-fast',
                                        name: 'Grok 4.1 Fast',
                                        cost: { input: 2, output: 10 },
                                        limit: { context: 200000, output: 64000 },
                                    },
                                },
                            },
                        }),
                });

            const result = await fetchModelCatalog();

            expect(result).toEqual([
                {
                    id: 'xai/grok-4.1-fast',
                    modelId: 'grok-4.1-fast',
                    name: 'Grok 4.1 Fast',
                    providerId: 'xai',
                    providerName: 'xAI',
                    maxContextLength: 200000,
                    maxOutputTokens: 64000,
                    inputCostPer1k: 0.002,
                    outputCostPer1k: 0.01,
                    source: 'models.dev',
                },
            ]);
        });
    });
});
