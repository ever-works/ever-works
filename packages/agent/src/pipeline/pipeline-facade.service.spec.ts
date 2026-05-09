import { PipelineFacadeService } from './pipeline-facade.service';

describe('PipelineFacadeService', () => {
    let aiFacade: any;
    let searchFacade: any;
    let screenshotFacade: any;
    let contentExtractorFacade: any;
    let promptFacade: any;
    let dataSourceFacade: any;
    let service: PipelineFacadeService;

    function makeWork(overrides: any = {}) {
        return {
            id: 'w1',
            slug: 'my-work',
            user: { id: 'u1' },
            ...overrides,
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();

        aiFacade = {
            askJson: jest.fn().mockResolvedValue({ data: { x: 1 } }),
            createChatCompletion: jest.fn().mockResolvedValue({ choices: [] }),
            createStreamingChatCompletion: jest.fn(),
            isConfigured: jest.fn().mockReturnValue(true),
            testConnection: jest.fn().mockResolvedValue({ ok: true }),
            getAvailableModels: jest.fn().mockResolvedValue([]),
            getProviderConfig: jest.fn().mockResolvedValue({ name: 'openai' }),
            resolveModelMetadata: jest.fn().mockResolvedValue({ id: 'gpt-4', maxTokens: 8192 }),
            resolveModelContextLength: jest.fn().mockResolvedValue(8192),
        };
        searchFacade = {
            search: jest.fn().mockResolvedValue([]),
            isConfigured: jest.fn().mockReturnValue(true),
        };
        screenshotFacade = {
            capture: jest.fn().mockResolvedValue({ url: 'x' }),
            getSmartImage: jest.fn().mockResolvedValue({ url: 'x' }),
            getScreenshotUrl: jest.fn().mockResolvedValue('x'),
            isAvailable: jest.fn().mockReturnValue(true),
            isConfigured: jest.fn().mockReturnValue(true),
        };
        contentExtractorFacade = {
            extractContent: jest.fn().mockResolvedValue({ text: 'a' }),
            extractContentWithDiagnostics: jest.fn().mockResolvedValue({ text: 'a', diag: {} }),
            isConfigured: jest.fn().mockReturnValue(true),
        };
        promptFacade = {
            getPrompt: jest.fn().mockResolvedValue('Hello'),
            isConfigured: jest.fn().mockReturnValue(true),
        };
        dataSourceFacade = {
            queryAll: jest.fn().mockResolvedValue({ items: [] }),
            getEnabledSources: jest.fn().mockResolvedValue([]),
            isConfigured: jest.fn().mockReturnValue(true),
        };

        service = new PipelineFacadeService(
            aiFacade,
            searchFacade,
            screenshotFacade,
            contentExtractorFacade,
            promptFacade,
            dataSourceFacade,
        );
    });

    describe('createStepExecutionContext — guard rails', () => {
        it('throws when work.user is undefined (missing user context)', () => {
            const work = makeWork({ user: undefined });
            expect(() => service.createStepExecutionContext(work as any)).toThrow(
                'User context is required for pipeline execution. Ensure WorkReference includes a user with an id.',
            );
        });

        it('throws when work.user.id is missing/empty', () => {
            const work = makeWork({ user: { id: '' } });
            expect(() => service.createStepExecutionContext(work as any)).toThrow(
                /User context is required for pipeline execution/,
            );
        });

        it('returns a complete StepExecutionContext with all 6 bound facades + logger + work + user + signal', () => {
            const work = makeWork();
            const signal = new AbortController().signal;

            const ctx = service.createStepExecutionContext(
                work as any,
                undefined,
                undefined,
                signal,
            );

            expect(ctx).toEqual(
                expect.objectContaining({
                    aiFacade: expect.any(Object),
                    searchFacade: expect.any(Object),
                    screenshotFacade: expect.any(Object),
                    contentExtractorFacade: expect.any(Object),
                    dataSourceFacade: expect.any(Object),
                    promptFacade: expect.any(Object),
                    logger: expect.any(Object),
                    work,
                    user: work.user,
                    signal,
                }),
            );
        });

        it('forwards undefined signal verbatim (not coerced)', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            expect(ctx.signal).toBeUndefined();
        });
    });

    describe('logger prefix', () => {
        it('prefixes every log/debug/warn/error/verbose call with [work.slug]', () => {
            const logSpy = jest
                .spyOn((service as any).logger, 'log')
                .mockImplementation(() => undefined);
            const debugSpy = jest
                .spyOn((service as any).logger, 'debug')
                .mockImplementation(() => undefined);
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);
            const errorSpy = jest
                .spyOn((service as any).logger, 'error')
                .mockImplementation(() => undefined);
            const verboseSpy = jest
                .spyOn((service as any).logger, 'verbose')
                .mockImplementation(() => undefined);

            const ctx = service.createStepExecutionContext(makeWork() as any);

            ctx.logger.log('hello', 'extra');
            ctx.logger.debug('debug-msg');
            ctx.logger.warn('warn-msg');
            ctx.logger.error('err-msg', 'trace', 'extra');
            ctx.logger.verbose('v-msg');

            expect(logSpy).toHaveBeenCalledWith('[my-work] hello', 'extra');
            expect(debugSpy).toHaveBeenCalledWith('[my-work] debug-msg');
            expect(warnSpy).toHaveBeenCalledWith('[my-work] warn-msg');
            expect(errorSpy).toHaveBeenCalledWith('[my-work] err-msg', 'trace', 'extra');
            expect(verboseSpy).toHaveBeenCalledWith('[my-work] v-msg');
        });

        it('verbose call uses optional-chain — no crash if logger.verbose is undefined', () => {
            (service as any).logger.verbose = undefined;
            const ctx = service.createStepExecutionContext(makeWork() as any);
            // Should not throw — `this.logger.verbose?.(...)` short-circuits.
            expect(() => ctx.logger.verbose('msg')).not.toThrow();
        });
    });

    describe('bound AI facade', () => {
        it('forwards askJson and injects {workId, userId, providerOverride} from the binding context', async () => {
            const ctx = service.createStepExecutionContext(
                makeWork() as any,
                { ai: 'anthropic' } as any,
            );

            await ctx.aiFacade.askJson(
                'Hi {{name}}',
                { name: 'string' } as any,
                { temperature: 0.5 } as any,
                {} as any,
            );

            expect(aiFacade.askJson).toHaveBeenCalledWith(
                'Hi {{name}}',
                { name: 'string' },
                expect.objectContaining({ temperature: 0.5 }),
                { workId: 'w1', userId: 'u1', providerOverride: 'anthropic' },
            );
        });

        it('aiModelOverride defaults into options.routing.modelOverride when caller did not specify', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any, undefined, 'gpt-4o');

            await ctx.aiFacade.askJson('Hi', { name: 'string' } as any, undefined, {} as any);

            const call = aiFacade.askJson.mock.calls[0];
            expect(call[2]).toMatchObject({ routing: { modelOverride: 'gpt-4o' } });
        });

        it('caller-provided modelOverride wins over aiModelOverride (?? semantics)', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any, undefined, 'gpt-4o');

            await ctx.aiFacade.askJson(
                'Hi',
                { name: 'string' } as any,
                { routing: { modelOverride: 'opus' } } as any,
                {} as any,
            );

            const call = aiFacade.askJson.mock.calls[0];
            expect(call[2].routing.modelOverride).toBe('opus');
        });

        it('createChatCompletion defaults options.model to aiModelOverride when caller did not set it', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any, undefined, 'sonnet');

            await ctx.aiFacade.createChatCompletion({ messages: [] } as any, {} as any);

            expect(aiFacade.createChatCompletion).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'sonnet', messages: [] }),
                { workId: 'w1', userId: 'u1', providerOverride: undefined },
            );
        });

        it('createChatCompletion does NOT override an explicit options.model (?? semantics)', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any, undefined, 'sonnet');

            await ctx.aiFacade.createChatCompletion(
                { model: 'opus', messages: [] } as any,
                {} as any,
            );

            const call = aiFacade.createChatCompletion.mock.calls[0];
            expect(call[0].model).toBe('opus');
        });

        it('createStreamingChatCompletion applies the same model defaulting + binding', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any, undefined, 'sonnet');

            ctx.aiFacade.createStreamingChatCompletion({ messages: [] } as any, {} as any);

            expect(aiFacade.createStreamingChatCompletion).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'sonnet' }),
                { workId: 'w1', userId: 'u1', providerOverride: undefined },
            );
        });

        it('isConfigured proxies through verbatim (no facadeOptions arg)', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            expect(ctx.aiFacade.isConfigured()).toBe(true);
            expect(aiFacade.isConfigured).toHaveBeenCalledWith();
        });

        it('testConnection / getAvailableModels / getProviderConfig forward bound options', async () => {
            const ctx = service.createStepExecutionContext(
                makeWork() as any,
                { ai: 'anthropic' } as any,
            );

            await ctx.aiFacade.testConnection({} as any);
            await ctx.aiFacade.getAvailableModels({} as any);
            await ctx.aiFacade.getProviderConfig({} as any);

            expect(aiFacade.testConnection).toHaveBeenCalledWith({
                workId: 'w1',
                userId: 'u1',
                providerOverride: 'anthropic',
            });
            expect(aiFacade.getAvailableModels).toHaveBeenCalledWith({
                workId: 'w1',
                userId: 'u1',
                providerOverride: 'anthropic',
            });
            expect(aiFacade.getProviderConfig).toHaveBeenCalledWith({
                workId: 'w1',
                userId: 'u1',
                providerOverride: 'anthropic',
            });
        });

        it('resolveModelMetadata + resolveModelContextLength forward modelId + bound options', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);

            await ctx.aiFacade.resolveModelMetadata('gpt-4', {} as any);
            await ctx.aiFacade.resolveModelContextLength('gpt-4', {} as any);

            expect(aiFacade.resolveModelMetadata).toHaveBeenCalledWith('gpt-4', {
                workId: 'w1',
                userId: 'u1',
                providerOverride: undefined,
            });
            expect(aiFacade.resolveModelContextLength).toHaveBeenCalledWith('gpt-4', {
                workId: 'w1',
                userId: 'u1',
                providerOverride: undefined,
            });
        });
    });

    describe('bound search facade', () => {
        it('forwards search args + bound options (workId, userId, providerOverride from search override)', async () => {
            const ctx = service.createStepExecutionContext(
                makeWork() as any,
                {
                    search: 'tavily',
                } as any,
            );

            await ctx.searchFacade.search('foo', { limit: 5 } as any, {} as any);

            expect(searchFacade.search).toHaveBeenCalledWith(
                'foo',
                { limit: 5 },
                {
                    userId: 'u1',
                    workId: 'w1',
                    providerOverride: 'tavily',
                },
            );
        });

        it('search providerOverride is undefined when no override set', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            await ctx.searchFacade.search('foo', undefined as any, {} as any);
            expect(searchFacade.search).toHaveBeenCalledWith('foo', undefined, {
                userId: 'u1',
                workId: 'w1',
                providerOverride: undefined,
            });
        });

        it('isConfigured proxies through', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            expect(ctx.searchFacade.isConfigured()).toBe(true);
            expect(searchFacade.isConfigured).toHaveBeenCalledWith();
        });
    });

    describe('bound screenshot facade', () => {
        it('capture / getSmartImage / getScreenshotUrl all forward {workId, userId, providerOverride: screenshot}', async () => {
            const ctx = service.createStepExecutionContext(
                makeWork() as any,
                {
                    screenshot: 'urlbox',
                } as any,
            );

            await ctx.screenshotFacade.capture({ url: 'x' } as any, {} as any);
            await ctx.screenshotFacade.getSmartImage({ url: 'x' } as any, {} as any);
            await ctx.screenshotFacade.getScreenshotUrl({ url: 'x' } as any, {} as any);

            for (const fn of [
                screenshotFacade.capture,
                screenshotFacade.getSmartImage,
                screenshotFacade.getScreenshotUrl,
            ]) {
                expect(fn).toHaveBeenCalledWith(
                    { url: 'x' },
                    { workId: 'w1', userId: 'u1', providerOverride: 'urlbox' },
                );
            }
        });

        it('isAvailable + isConfigured both proxy through', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            expect(ctx.screenshotFacade.isAvailable()).toBe(true);
            expect(ctx.screenshotFacade.isConfigured()).toBe(true);
        });
    });

    describe('bound content-extractor facade', () => {
        it('extractContent + extractContentWithDiagnostics forward bound options w/ contentExtractor override', async () => {
            const ctx = service.createStepExecutionContext(
                makeWork() as any,
                {
                    contentExtractor: 'jina',
                } as any,
            );

            await ctx.contentExtractorFacade.extractContent(
                'http://x',
                { fmt: 'md' } as any,
                {} as any,
            );
            await ctx.contentExtractorFacade.extractContentWithDiagnostics(
                'http://x',
                { fmt: 'md' } as any,
                {} as any,
            );

            const expectedBound = {
                userId: 'u1',
                workId: 'w1',
                providerOverride: 'jina',
            };
            expect(contentExtractorFacade.extractContent).toHaveBeenCalledWith(
                'http://x',
                { fmt: 'md' },
                expectedBound,
            );
            expect(contentExtractorFacade.extractContentWithDiagnostics).toHaveBeenCalledWith(
                'http://x',
                { fmt: 'md' },
                expectedBound,
            );
        });

        it('isConfigured proxies through', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            expect(ctx.contentExtractorFacade.isConfigured()).toBe(true);
        });
    });

    describe('bound prompt facade', () => {
        it('getPrompt forwards (key, defaultPrompt, {workId, userId}) — NO providerOverride field', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);

            await ctx.promptFacade.getPrompt('greeting', 'Hi');

            expect(promptFacade.getPrompt).toHaveBeenCalledWith('greeting', 'Hi', {
                workId: 'w1',
                userId: 'u1',
            });
        });

        it('isConfigured proxies through', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            expect(ctx.promptFacade.isConfigured()).toBe(true);
        });
    });

    describe('bound data-source facade', () => {
        it('queryAll merges {workId, userId} INTO caller options (caller-supplied workId/userId is overwritten by binding)', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);

            // The wrapper spreads caller options FIRST then sets workId/userId
            // last, so caller-provided workId/userId is discarded — pinned.
            await ctx.dataSourceFacade!.queryAll({ workId: 'OTHER', userId: 'OTHER' } as any);

            expect(dataSourceFacade.queryAll).toHaveBeenCalledWith({
                workId: 'w1',
                userId: 'u1',
            });
        });

        it('getEnabledSources accepts caller userId override but defaults to bound userId when caller passes empty/falsy', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);

            await ctx.dataSourceFacade!.getEnabledSources('w-other', '');

            // The wrapper does `userId || ctx.userId` so empty string falls back.
            expect(dataSourceFacade.getEnabledSources).toHaveBeenCalledWith('w-other', 'u1');
        });

        it('getEnabledSources passes through caller userId when truthy', async () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            await ctx.dataSourceFacade!.getEnabledSources('w-other', 'u-custom');
            expect(dataSourceFacade.getEnabledSources).toHaveBeenCalledWith('w-other', 'u-custom');
        });

        it('isConfigured proxies through', () => {
            const ctx = service.createStepExecutionContext(makeWork() as any);
            expect(ctx.dataSourceFacade!.isConfigured()).toBe(true);
        });

        it('returns undefined dataSourceFacade when the optional dependency is not provided', () => {
            const slim = new PipelineFacadeService(
                aiFacade,
                searchFacade,
                screenshotFacade,
                contentExtractorFacade,
                promptFacade,
                undefined as any,
            );
            const ctx = slim.createStepExecutionContext(makeWork() as any);
            expect(ctx.dataSourceFacade).toBeUndefined();
        });
    });

    describe('binding context shape', () => {
        it('aiModelOverride + providerOverrides are forwarded into the binding context (not the underlying facade options for non-AI cases)', async () => {
            // Non-AI bound facades should NOT carry aiModelOverride; only the
            // AI facade applies that field via the routing.modelOverride path.
            const ctx = service.createStepExecutionContext(
                makeWork() as any,
                { search: 'tavily' } as any,
                'gpt-4o',
            );

            await ctx.searchFacade.search('q', undefined as any, {} as any);

            const call = searchFacade.search.mock.calls[0];
            expect(call[2]).not.toHaveProperty('aiModelOverride');
            expect(call[2]).toEqual({ userId: 'u1', workId: 'w1', providerOverride: 'tavily' });
        });
    });
});
