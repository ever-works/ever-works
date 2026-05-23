import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    WorkReference,
    GenerationRequest,
    StepExecutionContext,
    StepLogger,
    IAiFacade,
    ISearchFacade,
    IScreenshotFacade,
    IContentExtractorFacade,
    IDataSourceFacade,
    IPromptFacade,
    AskJsonOptions,
    AskJsonResponse,
    SchemaType,
    ChatCompletionOptions,
    ChatCompletionResponse,
    ChatCompletionChunk,
    EmbeddingOptions,
    EmbeddingResponse,
    SearchFacadeOptions,
    SearchFacadeResult,
    ScreenshotCaptureOptions,
    ScreenshotCaptureResult,
    SmartImageOptions,
    SmartImageResult,
    FacadeContentExtractionResult,
    FacadeExtractionOptions,
    FacadeExtractedContent,
    DataSourceFacadeOptions,
    DataSourceFacadeResult,
    EnabledDataSource,
    FacadeOptions,
    IKbToolsFacade,
} from '@ever-works/plugin';
import type { KbContextBundleData } from '@ever-works/contracts';
import { AiFacadeService } from '../facades/ai.facade';
import { SearchFacadeService } from '../facades/search.facade';
import { ScreenshotFacadeService } from '../facades/screenshot.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { DataSourceFacadeService } from '../facades/data-source.facade';
import { PromptFacadeService } from '../facades/prompt.facade';

/**
 * Context for binding facades to a specific work/user.
 */
export interface FacadeBindingContext {
    readonly workId: string;
    readonly userId: string;
    readonly aiModelOverride?: string;
    readonly providerOverrides?: {
        readonly ai?: string;
        readonly search?: string;
        readonly screenshot?: string;
        readonly contentExtractor?: string;
    };
}

/**
 * Service for creating bound facades for pipeline execution.
 *
 * Facades are "bound" to a specific work/user context so that
 * pipeline steps don't need to pass facadeOptions manually.
 *
 * Used by both StepPipelineExecutorService and FullPipelineExecutorService.
 */
@Injectable()
export class PipelineFacadeService {
    private readonly logger = new Logger(PipelineFacadeService.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly searchFacade: SearchFacadeService,
        private readonly screenshotFacade: ScreenshotFacadeService,
        private readonly contentExtractorFacade: ContentExtractorFacadeService,
        private readonly promptFacade: PromptFacadeService,
        @Optional() private readonly dataSourceFacade?: DataSourceFacadeService,
    ) {}

    /**
     * Create a StepExecutionContext for step executors.
     * Provides access to bound facades that automatically include work context.
     *
     * EW-641 Phase 2/b row 32b — accepts an optional `kbContext` carrier.
     * When provided (orchestrator wiring lands in a follow-up sub-chunk),
     * step executors read the resolved KB documents from
     * `execContext.kbContext.{alwaysInjected,queryRetrieved}` without
     * re-calling `KnowledgeBaseService.resolveContext`.
     */
    createStepExecutionContext(
        work: WorkReference,
        providerOverrides?: GenerationRequest['providers'],
        aiModelOverride?: string,
        signal?: AbortSignal,
        kbContext?: KbContextBundleData,
        kbTools?: IKbToolsFacade,
    ): StepExecutionContext {
        const stepLogger: StepLogger = {
            log: (msg: string, ...args: unknown[]) =>
                this.logger.log(`[${work.slug}] ${msg}`, ...args),
            debug: (msg: string, ...args: unknown[]) =>
                this.logger.debug(`[${work.slug}] ${msg}`, ...args),
            warn: (msg: string, ...args: unknown[]) =>
                this.logger.warn(`[${work.slug}] ${msg}`, ...args),
            error: (msg: string, trace?: string, ...args: unknown[]) =>
                this.logger.error(`[${work.slug}] ${msg}`, trace, ...args),
            verbose: (msg: string, ...args: unknown[]) =>
                this.logger.verbose?.(`[${work.slug}] ${msg}`, ...args),
        };

        if (!work.user?.id) {
            throw new Error(
                'User context is required for pipeline execution. ' +
                    'Ensure WorkReference includes a user with an id.',
            );
        }
        const facadeContext: FacadeBindingContext = {
            workId: work.id,
            userId: work.user.id,
            aiModelOverride,
            providerOverrides,
        };

        return {
            aiFacade: this.createBoundAiFacade(facadeContext),
            searchFacade: this.createBoundSearchFacade(facadeContext),
            screenshotFacade: this.createBoundScreenshotFacade(facadeContext),
            contentExtractorFacade: this.createBoundContentExtractorFacade(facadeContext),
            dataSourceFacade: this.createBoundDataSourceFacade(facadeContext),
            promptFacade: this.createBoundPromptFacade(facadeContext),
            logger: stepLogger,
            work,
            user: work.user,
            signal,
            kbContext,
            kbTools,
        };
    }

    private createBoundAiFacade(ctx: FacadeBindingContext): IAiFacade {
        const facade = this.aiFacade;
        const boundFacadeOptions: FacadeOptions = {
            workId: ctx.workId,
            userId: ctx.userId,
            providerOverride: ctx.providerOverrides?.ai,
        };
        return {
            askJson: <T, Template extends string = string>(
                promptTemplate: Template,
                schema: SchemaType<T>,
                options: AskJsonOptions<Template> | undefined,
                _facadeOptions: FacadeOptions,
            ): Promise<AskJsonResponse<T>> =>
                facade.askJson(
                    promptTemplate,
                    schema as any,
                    {
                        ...options,
                        routing: {
                            ...options?.routing,
                            modelOverride: options?.routing?.modelOverride ?? ctx.aiModelOverride,
                        },
                    },
                    boundFacadeOptions,
                ),
            createChatCompletion: (
                options: ChatCompletionOptions,
                _facadeOptions: FacadeOptions,
            ): Promise<ChatCompletionResponse> =>
                facade.createChatCompletion(
                    {
                        ...options,
                        model: options.model ?? ctx.aiModelOverride,
                    },
                    boundFacadeOptions,
                ),
            createStreamingChatCompletion: (
                options: ChatCompletionOptions,
                _facadeOptions: FacadeOptions,
            ): AsyncGenerator<ChatCompletionChunk> =>
                facade.createStreamingChatCompletion(
                    {
                        ...options,
                        model: options.model ?? ctx.aiModelOverride,
                    },
                    boundFacadeOptions,
                ),
            // EW-641 Phase 2/a row 29b2a — pipeline-bound shim that forwards
            // to the real AiFacadeService.embed. Pipelines don't currently
            // call embed (Phase 2/b will), but the IAiFacade contract
            // requires the method so the binding shape stays complete.
            embed: (
                options: EmbeddingOptions,
                _facadeOptions: FacadeOptions,
            ): Promise<EmbeddingResponse> => facade.embed(options, boundFacadeOptions),
            isConfigured: () => facade.isConfigured(),
            testConnection: (_facadeOptions: FacadeOptions) =>
                facade.testConnection(boundFacadeOptions),
            getAvailableModels: (_facadeOptions: FacadeOptions) =>
                facade.getAvailableModels(boundFacadeOptions),
            getProviderConfig: (_facadeOptions: FacadeOptions) =>
                facade.getProviderConfig(boundFacadeOptions),
            resolveModelMetadata: (modelId: string, _facadeOptions: FacadeOptions) =>
                facade.resolveModelMetadata(modelId, boundFacadeOptions),
            resolveModelContextLength: (modelId: string, _facadeOptions: FacadeOptions) =>
                facade.resolveModelContextLength(modelId, boundFacadeOptions),
        };
    }

    private createBoundSearchFacade(ctx: FacadeBindingContext): ISearchFacade {
        const facade = this.searchFacade;
        return {
            search: (
                query: string,
                options: SearchFacadeOptions | undefined,
                _facadeOptions: FacadeOptions,
            ): Promise<SearchFacadeResult[]> =>
                facade.search(query, options, {
                    userId: ctx.userId,
                    workId: ctx.workId,
                    providerOverride: ctx.providerOverrides?.search,
                }),
            isConfigured: () => facade.isConfigured(),
        };
    }

    private createBoundScreenshotFacade(ctx: FacadeBindingContext): IScreenshotFacade {
        const facade = this.screenshotFacade;
        return {
            capture: (
                options: ScreenshotCaptureOptions,
                _facadeOptions: FacadeOptions,
            ): Promise<ScreenshotCaptureResult> =>
                facade.capture(options, {
                    workId: ctx.workId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.screenshot,
                }),
            getSmartImage: (
                options: SmartImageOptions,
                _facadeOptions: FacadeOptions,
            ): Promise<SmartImageResult> =>
                facade.getSmartImage(options, {
                    workId: ctx.workId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.screenshot,
                }),
            getScreenshotUrl: (
                options: ScreenshotCaptureOptions,
                _facadeOptions: FacadeOptions,
            ): Promise<string | null> =>
                facade.getScreenshotUrl(options, {
                    workId: ctx.workId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.screenshot,
                }),
            isAvailable: () => facade.isAvailable(),
            isConfigured: () => facade.isConfigured(),
        };
    }

    private createBoundContentExtractorFacade(ctx: FacadeBindingContext): IContentExtractorFacade {
        const facade = this.contentExtractorFacade;
        return {
            extractContent: (
                url: string,
                options: FacadeExtractionOptions | undefined,
                _facadeOptions: FacadeOptions,
            ): Promise<FacadeExtractedContent | null> =>
                facade.extractContent(url, options, {
                    userId: ctx.userId,
                    workId: ctx.workId,
                    providerOverride: ctx.providerOverrides?.contentExtractor,
                }),
            extractContentWithDiagnostics: (
                url: string,
                options: FacadeExtractionOptions | undefined,
                _facadeOptions: FacadeOptions,
            ): Promise<FacadeContentExtractionResult> =>
                facade.extractContentWithDiagnostics(url, options, {
                    userId: ctx.userId,
                    workId: ctx.workId,
                    providerOverride: ctx.providerOverrides?.contentExtractor,
                }),
            isConfigured: () => facade.isConfigured(),
        };
    }

    private createBoundPromptFacade(ctx: FacadeBindingContext): IPromptFacade {
        const facade = this.promptFacade;
        const boundFacadeOptions: FacadeOptions = {
            workId: ctx.workId,
            userId: ctx.userId,
        };
        return {
            getPrompt: (
                key: string,
                defaultPrompt: string,
                _facadeOptions?: FacadeOptions,
            ): Promise<string> => facade.getPrompt(key, defaultPrompt, boundFacadeOptions),
            isConfigured: () => facade.isConfigured(),
        };
    }

    private createBoundDataSourceFacade(ctx: FacadeBindingContext): IDataSourceFacade | undefined {
        if (!this.dataSourceFacade) {
            return undefined;
        }
        const facade = this.dataSourceFacade;
        return {
            queryAll: (options: DataSourceFacadeOptions): Promise<DataSourceFacadeResult> =>
                facade.queryAll({
                    ...options,
                    workId: ctx.workId,
                    userId: ctx.userId,
                }),
            getEnabledSources: (workId: string, userId: string): Promise<EnabledDataSource[]> =>
                facade.getEnabledSources(workId, userId || ctx.userId),
            isConfigured: () => facade.isConfigured(),
        };
    }
}
