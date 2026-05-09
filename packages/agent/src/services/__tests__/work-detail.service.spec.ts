import {
    WorkDetailService,
    WORK_DETAIL_PROMPT,
    workDetailSchema,
} from '../work-detail.service';
import type { User } from '@src/entities/user.entity';

describe('WorkDetailService', () => {
    let aiFacade: { askJson: jest.Mock };
    let workRepository: { existsByUserAndSlug: jest.Mock };
    let service: WorkDetailService;
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        aiFacade = { askJson: jest.fn() };
        workRepository = { existsByUserAndSlug: jest.fn().mockResolvedValue(false) };
        service = new WorkDetailService(aiFacade as any, workRepository as any);
        // Silence the logger and reassert via the spies in error-path tests.
        errorSpy = jest
            .spyOn((service as any).logger, 'error')
            .mockImplementation(() => undefined);
        logSpy = jest
            .spyOn((service as any).logger, 'log')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        jest.clearAllMocks();
    });

    const buildUser = (overrides: Partial<User> = {}): User =>
        ({ id: 'user-1', ...overrides }) as User;

    describe('module-level exports', () => {
        it('exports WORK_DETAIL_PROMPT containing the {name} and {prompt} interpolation tokens', () => {
            // Pinned because the AI facade does the variable substitution
            // — if these tokens are renamed without updating the facade
            // contract the prompt would silently send the literal `{name}`
            // string to the LLM and tank quality.
            expect(WORK_DETAIL_PROMPT).toContain('{name}');
            expect(WORK_DETAIL_PROMPT).toContain('{prompt}');
            expect(WORK_DETAIL_PROMPT).toContain('Work Name:');
            expect(WORK_DETAIL_PROMPT).toContain('User Prompt:');
        });

        it('exports workDetailSchema with description (string), keywords (string[]), categories (string[] | null)', () => {
            // Pinned schema shape because it is part of the AI tool-call
            // contract. A future column add must be deliberate (and the
            // service code must map it through `result.<field>`).
            const valid = workDetailSchema.safeParse({
                description: 'desc',
                keywords: ['k1'],
                categories: ['c1'],
            });
            expect(valid.success).toBe(true);

            const validNullCategories = workDetailSchema.safeParse({
                description: 'desc',
                keywords: ['k1'],
                categories: null,
            });
            expect(validNullCategories.success).toBe(true);

            const missingCategories = workDetailSchema.safeParse({
                description: 'desc',
                keywords: ['k1'],
            });
            // categories is `.nullable()`, NOT `.optional()` — undefined
            // must be rejected so the AI is forced to emit `null` rather
            // than silently omit the field. Pinned because a future swap
            // to `.optional()` would change the API contract.
            expect(missingCategories.success).toBe(false);
        });
    });

    describe('generateWorkDetails — happy path', () => {
        it('forwards prompt + schema + variables + provider override to aiFacade.askJson with the documented options shape', async () => {
            // Pinned shape so a future widening (e.g. adding more
            // routing knobs) is a deliberate change. Specifically:
            //   - temperature: 0 (we want deterministic output for
            //     metadata extraction)
            //   - variables: { name, prompt } (interpolation source)
            //   - routing: { complexity: 'simple' } (this is a cheap
            //     extract-only call, NOT a heavy generation call)
            //   - userId from user.id
            //   - providerOverride forwarded verbatim
            aiFacade.askJson.mockResolvedValue({
                result: {
                    description: 'A nice work',
                    keywords: ['k1', 'k2'],
                    categories: ['c1'],
                },
            });

            await service.generateWorkDetails(
                'My Work',
                'A useful collection of things',
                buildUser({ id: 'user-42' }),
                'openai',
            );

            expect(aiFacade.askJson).toHaveBeenCalledTimes(1);
            const [prompt, schema, options, context] = aiFacade.askJson.mock.calls[0];
            expect(prompt).toBe(WORK_DETAIL_PROMPT);
            expect(schema).toBe(workDetailSchema);
            expect(options).toEqual({
                temperature: 0,
                variables: { name: 'My Work', prompt: 'A useful collection of things' },
                routing: { complexity: 'simple' },
            });
            expect(context).toEqual({ userId: 'user-42', providerOverride: 'openai' });
        });

        it('forwards undefined providerOverride when aiProvider arg is omitted', async () => {
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            await service.generateWorkDetails('Name', 'Prompt', buildUser());

            const context = aiFacade.askJson.mock.calls[0][3];
            expect(context.providerOverride).toBeUndefined();
        });

        it('sanitizes the AI-returned description (strips newlines and control chars) for GitHub compat', async () => {
            // Pinned because GitHub repository descriptions reject newlines
            // and the AI happily returns multi-paragraph blurbs. The
            // service applies sanitizeDescription as the boundary step.
            aiFacade.askJson.mockResolvedValue({
                result: {
                    description: 'Line 1\nLine 2\n\nLine 3\twith tab',
                    keywords: [],
                    categories: [],
                },
            });

            const result = await service.generateWorkDetails('Name', 'Prompt', buildUser());

            expect(result.description).not.toContain('\n');
            expect(result.description).toBe('Line 1 Line 2 Line 3 with tab');
        });

        it('sanitizes the AI-returned keywords array (trims, drops empties)', async () => {
            aiFacade.askJson.mockResolvedValue({
                result: {
                    description: 'd',
                    keywords: ['  k1  ', '', 'k2', '   '],
                    categories: [],
                },
            });

            const result = await service.generateWorkDetails('Name', 'Prompt', buildUser());

            expect(result.keywords).toEqual(['k1', 'k2']);
        });

        it('sanitizes the AI-returned categories array (trims, drops empties)', async () => {
            aiFacade.askJson.mockResolvedValue({
                result: {
                    description: 'd',
                    keywords: [],
                    categories: ['Cat A', '  ', '\nCat B\n'],
                },
            });

            const result = await service.generateWorkDetails('Name', 'Prompt', buildUser());

            expect(result.categories).toEqual(['Cat A', 'Cat B']);
        });

        it('coerces null categories to [] before sanitisation (regression guard for nullable schema)', async () => {
            // Pinned: the schema marks categories as `.nullable()` so the
            // AI may legitimately return `null`. The service uses
            // `result.categories || []` to coerce; a future swap to `??`
            // would NOT change current behaviour but a swap to direct
            // forwarding would crash sanitizeStringArray on null.
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: null },
            });

            const result = await service.generateWorkDetails('Name', 'Prompt', buildUser());

            expect(result.categories).toEqual([]);
        });

        it('returns the documented WorkDetails envelope shape with name preserved verbatim', async () => {
            aiFacade.askJson.mockResolvedValue({
                result: {
                    description: 'AI tools for developers',
                    keywords: ['ai', 'tools'],
                    categories: ['ai'],
                },
            });

            const result = await service.generateWorkDetails(
                'AI Tools Hub',
                'Curated AI tools for developers',
                buildUser({ id: 'user-1' }),
            );

            expect(result).toEqual({
                name: 'AI Tools Hub',
                slug: 'ai-tools-hub',
                description: 'AI tools for developers',
                keywords: ['ai', 'tools'],
                categories: ['ai'],
            });
        });

        it('logs the extraction-start line at log level (one Logger#log call per invocation)', async () => {
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            await service.generateWorkDetails('My Work', 'p', buildUser());

            expect(logSpy).toHaveBeenCalledWith('Extracting details for work: My Work');
        });
    });

    describe('generateWorkDetails — slug uniqueness', () => {
        it('returns the base slug when no row collides', async () => {
            workRepository.existsByUserAndSlug.mockResolvedValue(false);
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            const result = await service.generateWorkDetails(
                'Hello World',
                'p',
                buildUser({ id: 'u-1' }),
            );

            expect(result.slug).toBe('hello-world');
            expect(workRepository.existsByUserAndSlug).toHaveBeenCalledTimes(1);
            expect(workRepository.existsByUserAndSlug).toHaveBeenCalledWith(
                'u-1',
                'hello-world',
            );
        });

        it('appends -1 when the base slug exists and -1 is free', async () => {
            workRepository.existsByUserAndSlug
                .mockResolvedValueOnce(true) // base
                .mockResolvedValueOnce(false); // base-1
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            const result = await service.generateWorkDetails(
                'Hello World',
                'p',
                buildUser({ id: 'u-1' }),
            );

            expect(result.slug).toBe('hello-world-1');
            expect(workRepository.existsByUserAndSlug).toHaveBeenNthCalledWith(
                1,
                'u-1',
                'hello-world',
            );
            expect(workRepository.existsByUserAndSlug).toHaveBeenNthCalledWith(
                2,
                'u-1',
                'hello-world-1',
            );
        });

        it('keeps incrementing the counter until a free slug is found', async () => {
            // Pinned because the loop condition is `while (await ...)` —
            // a future refactor to a max-iterations guard would change
            // the contract (and would require explicit error semantics).
            workRepository.existsByUserAndSlug
                .mockResolvedValueOnce(true) // base
                .mockResolvedValueOnce(true) // -1
                .mockResolvedValueOnce(true) // -2
                .mockResolvedValueOnce(false); // -3
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            const result = await service.generateWorkDetails(
                'Test',
                'p',
                buildUser({ id: 'u-1' }),
            );

            expect(result.slug).toBe('test-3');
            expect(workRepository.existsByUserAndSlug).toHaveBeenCalledTimes(4);
        });

        it('scopes the existence check to the user (regression guard against cross-user slug clashes)', async () => {
            // Pinned: slugs are PER-USER unique; a future swap to a global
            // slug check would force a different user collision-resolution
            // policy. The userId argument is the protection.
            workRepository.existsByUserAndSlug.mockResolvedValue(false);
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            await service.generateWorkDetails(
                'Same Name',
                'p',
                buildUser({ id: 'user-A' }),
            );

            expect(workRepository.existsByUserAndSlug).toHaveBeenCalledWith(
                'user-A',
                'same-name',
            );
        });
    });

    describe('generateWorkDetails — fallback path on AI failure', () => {
        it('falls back to a synthetic envelope when aiFacade.askJson rejects with an Error', async () => {
            // Pinned: the catch block must NOT rethrow — the work
            // creation flow depends on always getting a metadata bundle
            // back. The fallback is intentionally minimal so the user
            // can still move forward and edit the work later.
            const err = new Error('AI provider down');
            (err as any).stack = 'stack-trace-here';
            aiFacade.askJson.mockRejectedValue(err);

            const result = await service.generateWorkDetails(
                'Recovery Work',
                'p',
                buildUser({ id: 'u-1' }),
            );

            expect(result).toEqual({
                name: 'Recovery Work',
                slug: 'recovery-work',
                description: 'Work for Recovery Work',
                keywords: ['recovery work'],
                categories: [],
            });
            expect(errorSpy).toHaveBeenCalledWith(
                'Error extracting details for work Recovery Work: AI provider down',
                'stack-trace-here',
            );
        });

        it('still applies sanitizeDescription to the fallback description (strips newlines)', async () => {
            // The fallback description includes the raw work name; if
            // a caller passes a name with newlines or control characters
            // the sanitisation MUST still fire. Pinned via a name that
            // the caller could legitimately pass through from a form.
            aiFacade.askJson.mockRejectedValue(new Error('ai failed'));

            const result = await service.generateWorkDetails(
                'My\nMulti-line\tName',
                'p',
                buildUser({ id: 'u-1' }),
            );

            expect(result.description).toBe('Work for My Multi-line Name');
        });

        it('uses the work name (lowercased, trimmed) as a single-element keyword in the fallback', async () => {
            aiFacade.askJson.mockRejectedValue(new Error('boom'));

            const result = await service.generateWorkDetails(
                '  Mixed Case Name  ',
                'p',
                buildUser({ id: 'u-1' }),
            );

            expect(result.keywords).toEqual(['mixed case name']);
        });

        it('still resolves a unique slug in the fallback path (loop runs through existence checks)', async () => {
            // Pinned: the catch block re-runs `generateUniqueSlug` so
            // the fallback envelope still gets a non-colliding slug —
            // a future refactor that returned `name` verbatim would
            // break the per-user uniqueness invariant on the work table.
            workRepository.existsByUserAndSlug
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false);
            aiFacade.askJson.mockRejectedValue(new Error('boom'));

            const result = await service.generateWorkDetails(
                'Conflict',
                'p',
                buildUser({ id: 'u-1' }),
            );

            expect(result.slug).toBe('conflict-1');
        });
    });

    describe('generateWorkDetails — slug derivation rules', () => {
        // The slug is derived via `slugifyText(name)` from `text.utils`
        // — pinning a few representative cases catches a future swap to
        // a different slug library or a tightening of the allowed-char
        // set.
        it('lowercases and hyphenates a multi-word name', async () => {
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            const result = await service.generateWorkDetails(
                'Hello Beautiful World',
                'p',
                buildUser(),
            );

            expect(result.slug).toBe('hello-beautiful-world');
        });

        it('handles a name with punctuation and produces a clean slug', async () => {
            aiFacade.askJson.mockResolvedValue({
                result: { description: 'd', keywords: [], categories: [] },
            });

            const result = await service.generateWorkDetails(
                "Cool Stuff! (and more?)",
                'p',
                buildUser(),
            );

            // The exact algorithm lives in `text.utils.slugifyText`. We
            // assert the invariants that matter to the storage layer:
            // lowercase, no leading/trailing hyphens, no consecutive
            // hyphens, no spaces.
            expect(result.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            expect(result.slug).toContain('cool');
            expect(result.slug).toContain('stuff');
            expect(result.slug).toContain('more');
        });
    });
});
