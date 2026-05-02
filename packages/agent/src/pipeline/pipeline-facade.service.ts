import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    DirectoryReference,
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
} from '@ever-works/plugin';
import { AiFacadeService } from '../facades/ai.facade';
import { SearchFacadeService } from '../facades/search.facade';
import { ScreenshotFacadeService } from '../facades/screenshot.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { DataSourceFacadeService } from '../facades/data-source.facade';
import { PromptFacadeService } from '../facades/prompt.facade';

/**
 * Context for binding facades to a specific directory/user.
 */
export interface FacadeBindingContext {
    readonly directoryId: string;
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
 * Facades are "bound" to a specific directory/user context so that
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
     * Provides access to bound facades that automatically include directory context.
     */
    createStepExecutionContext(
        directory: DirectoryReference,
        providerOverrides?: GenerationRequest['providers'],
        aiModelOverride?: string,
        signal?: AbortSignal,
    ): StepExecutionContext {
        const stepLogger: StepLogger = {
            log: (msg: string, ...args: unknown[]) =>
                this.logger.log(`[${directory.slug}] ${msg}`, ...args),
            debug: (msg: string, ...args: unknown[]) =>
                this.logger.debug(`[${directory.slug}] ${msg}`, ...args),
            warn: (msg: string, ...args: unknown[]) =>
                this.logger.warn(`[${directory.slug}] ${msg}`, ...args),
            error: (msg: string, trace?: string, ...args: unknown[]) =>
                this.logger.error(`[${directory.slug}] ${msg}`, trace, ...args),
            verbose: (msg: string, ...args: unknown[]) =>
                this.logger.verbose?.(`[${directory.slug}] ${msg}`, ...args),
        };

        if (!directory.user?.id) {
            throw new Error(
                'User context is required for pipeline execution. ' +
                    'Ensure DirectoryReference includes a user with an id.',
            );
        }
        const facadeContext: FacadeBindingContext = {
            directoryId: directory.id,
            userId: directory.user.id,
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
            directory,
            user: directory.user,
            signal,
        };
    }

    private createBoundAiFacade(ctx: FacadeBindingContext): IAiFacade {
        const facade = this.aiFacade;
        const boundFacadeOptions: FacadeOptions = {
            directoryId: ctx.directoryId,
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
                    directoryId: ctx.directoryId,
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
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.screenshot,
                }),
            getSmartImage: (
                options: SmartImageOptions,
                _facadeOptions: FacadeOptions,
            ): Promise<SmartImageResult> =>
                facade.getSmartImage(options, {
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                    providerOverride: ctx.providerOverrides?.screenshot,
                }),
            getScreenshotUrl: (
                options: ScreenshotCaptureOptions,
                _facadeOptions: FacadeOptions,
            ): Promise<string | null> =>
                facade.getScreenshotUrl(options, {
                    directoryId: ctx.directoryId,
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
                    directoryId: ctx.directoryId,
                    providerOverride: ctx.providerOverrides?.contentExtractor,
                }),
            extractContentWithDiagnostics: (
                url: string,
                options: FacadeExtractionOptions | undefined,
                _facadeOptions: FacadeOptions,
            ): Promise<FacadeContentExtractionResult> =>
                facade.extractContentWithDiagnostics(url, options, {
                    userId: ctx.userId,
                    directoryId: ctx.directoryId,
                    providerOverride: ctx.providerOverrides?.contentExtractor,
                }),
            isConfigured: () => facade.isConfigured(),
        };
    }

    private createBoundPromptFacade(ctx: FacadeBindingContext): IPromptFacade {
        const facade = this.promptFacade;
        const boundFacadeOptions: FacadeOptions = {
            directoryId: ctx.directoryId,
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
                    directoryId: ctx.directoryId,
                    userId: ctx.userId,
                }),
            getEnabledSources: (
                directoryId: string,
                userId: string,
            ): Promise<EnabledDataSource[]> =>
                facade.getEnabledSources(directoryId, userId || ctx.userId),
            isConfigured: () => facade.isConfigured(),
        };
    }
}
