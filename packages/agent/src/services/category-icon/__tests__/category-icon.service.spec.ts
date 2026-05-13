// p-map is ESM-only and Jest can't load it under ts-jest. Replace with a
// trivial Promise.all-equivalent — concurrency limits don't matter for tests.
jest.mock('p-map', () => ({
    __esModule: true,
    default: async <T, R>(
        input: Iterable<T>,
        mapper: (value: T, index: number) => Promise<R> | R,
    ): Promise<R[]> => Promise.all([...input].map((value, index) => mapper(value, index))),
}));

import type { Cache } from 'cache-manager';
import type { Category, ChatCompletionResponse, FacadeOptions } from '@ever-works/plugin';

import type { AiFacadeService } from '../../../facades/ai.facade';
import { CategoryIconService } from '../category-icon.service';

const FACADE_OPTIONS: FacadeOptions = { userId: 'user-1', workId: 'work-1' };

const CLEAN_AI_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6"/></svg>';

function buildAiResponse(content: string): ChatCompletionResponse {
    return {
        id: 'r-1',
        model: 'mock-model',
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content },
                finishReason: 'stop',
            },
        ],
        created: Date.now(),
    } as unknown as ChatCompletionResponse;
}

function makeAiFacadeMock(
    content: string | (() => Promise<ChatCompletionResponse>),
): AiFacadeService {
    const createChatCompletion = jest.fn().mockImplementation(async () => {
        if (typeof content === 'function') {
            return content();
        }
        return buildAiResponse(content);
    });
    return { createChatCompletion } as unknown as AiFacadeService;
}

function makeCacheMock(
    initial: Record<string, string> = {},
): Cache & { _store: Map<string, string> } {
    const store = new Map<string, string>(Object.entries(initial));
    return {
        _store: store,
        get: jest.fn(async (key: string) => store.get(key)),
        set: jest.fn(async (key: string, value: unknown) => {
            store.set(key, String(value));
        }),
        del: jest.fn(async (key: string) => {
            store.delete(key);
        }),
    } as unknown as Cache & { _store: Map<string, string> };
}

describe('CategoryIconService', () => {
    describe('ensureIcon', () => {
        it('returns from cache without calling AI when a cached entry exists', async () => {
            const cached =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>';
            const cache = makeCacheMock({ 'category-icon:v1:productivity': cached });
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade, cache);

            const result = await service.ensureIcon({
                name: 'Productivity',
                facadeOptions: FACADE_OPTIONS,
            });

            expect(result.source).toBe('cache');
            expect(result.svg).toBe(cached);
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
        });

        it('returns curated SVG without calling AI when name matches a known concept', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade, cache);

            const result = await service.ensureIcon({
                name: 'Time-Tracking',
                facadeOptions: FACADE_OPTIONS,
            });

            expect(result.source).toBe('curated');
            expect(result.svg).toContain('<svg');
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
            // and writes to cache for next time
            expect(cache._store.has('category-icon:v1:time-tracking')).toBe(true);
        });

        it('falls through to AI when no curated match exists', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade, cache);

            const result = await service.ensureIcon({
                name: 'Quantum Spectroscopy Hardware',
                facadeOptions: FACADE_OPTIONS,
            });

            expect(result.source).toBe('ai');
            expect(aiFacade.createChatCompletion).toHaveBeenCalledTimes(1);
            expect(cache._store.has('category-icon:v1:quantum spectroscopy hardware')).toBe(true);
        });

        it('falls back to the static glyph when AI fails and no curated match exists', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock(async () => {
                throw new Error('provider down');
            });
            const service = new CategoryIconService(aiFacade, cache);

            const result = await service.ensureIcon({
                name: 'Astrophysics Telescopes',
                facadeOptions: FACADE_OPTIONS,
            });

            expect(result.source).toBe('fallback');
            expect(result.svg).toContain('<svg');
        });

        it('falls back to the static glyph when AI returns markup that fails sanitization', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock('<svg viewBox="0 0 24 24"><script>alert(1)</script>');
            const service = new CategoryIconService(aiFacade, cache);

            const result = await service.ensureIcon({
                name: 'Astrophysics Telescopes',
                facadeOptions: FACADE_OPTIONS,
            });

            expect(result.source).toBe('fallback');
            expect(result.svg).not.toContain('script');
        });

        it('skips the AI tier when disableAi is true', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade, cache);

            const result = await service.ensureIcon({
                name: 'Quantum Spectroscopy Hardware',
                facadeOptions: FACADE_OPTIONS,
                disableAi: true,
            });

            expect(result.source).toBe('fallback');
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
        });

        it('returns the fallback when name normalizes to an empty string', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade, cache);

            const result = await service.ensureIcon({
                name: '   ',
                facadeOptions: FACADE_OPTIONS,
            });

            expect(result.source).toBe('fallback');
            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
        });

        it('still works without an injected cache (degrades gracefully)', async () => {
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade);

            const result = await service.ensureIcon({
                name: 'Productivity',
                facadeOptions: FACADE_OPTIONS,
            });

            expect(result.source).toBe('curated');
        });
    });

    describe('enrichCategories', () => {
        it('skips entries that already have a non-empty icon_svg', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade, cache);

            const input: Category[] = [
                { id: 'a', name: 'Productivity', icon_svg: '<svg>existing</svg>' },
                { id: 'b', name: 'Time-Tracking' },
            ];

            const out = await service.enrichCategories(input, { facadeOptions: FACADE_OPTIONS });

            expect(out).toHaveLength(2);
            expect(out[0].icon_svg).toBe('<svg>existing</svg>');
            expect(out[1].icon_svg).toContain('<svg');
        });

        it('returns the input unchanged when given an empty list', async () => {
            const cache = makeCacheMock();
            const aiFacade = makeAiFacadeMock(CLEAN_AI_SVG);
            const service = new CategoryIconService(aiFacade, cache);

            const out = await service.enrichCategories([], { facadeOptions: FACADE_OPTIONS });
            expect(out).toEqual([]);
        });

        it('continues the batch when a single category resolution throws', async () => {
            const cache = makeCacheMock();
            // First call fails, subsequent calls succeed.
            let calls = 0;
            const aiFacade = makeAiFacadeMock(async () => {
                calls += 1;
                if (calls === 1) throw new Error('rate limited');
                return buildAiResponse(CLEAN_AI_SVG);
            });
            const service = new CategoryIconService(aiFacade, cache);

            const input: Category[] = [
                { id: 'a', name: 'Quantum Spectroscopy Hardware' },
                { id: 'b', name: 'Productivity' }, // hits curated, no AI call
                { id: 'c', name: 'Astrophysics Telescopes' },
            ];

            const out = await service.enrichCategories(input, { facadeOptions: FACADE_OPTIONS });
            expect(out).toHaveLength(3);
            // First entry's AI call failed → fallback applied (not undefined)
            expect(out[0].icon_svg).toBeDefined();
            expect(out[1].icon_svg).toContain('<svg');
            expect(out[2].icon_svg).toBeDefined();
        });
    });
});
