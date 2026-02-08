import type { IAiFacade } from '../facades/ai-facade.interface.js';
import type { ISearchFacade } from '../facades/search-facade.interface.js';
import type { IScreenshotFacade } from '../facades/screenshot-facade.interface.js';
import type { IContentExtractorFacade } from '../facades/content-extractor-facade.interface.js';
import type { IDataSourceFacade } from '../facades/data-source-facade.interface.js';
import type { DirectoryReference, UserReference } from './generation-context.interface.js';

/**
 * Logger interface for step execution.
 * Compatible with NestJS Logger but framework-agnostic.
 */
export interface StepLogger {
	log(message: string, ...args: unknown[]): void;
	error(message: string, trace?: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	verbose?(message: string, ...args: unknown[]): void;
}

/**
 * Step Execution Context.
 *
 * This context is passed to pipeline step executors and provides access to
 * all facades and utilities needed for step execution.
 *
 * The context is created by the pipeline executor and populated with
 * facade implementations that handle provider resolution and settings.
 *
 * @example
 * ```typescript
 * class MyStep implements IBuiltInStepExecutor {
 *     async run(
 *         context: MutableGenerationContext,
 *         execContext: StepExecutionContext
 *     ): Promise<MutableGenerationContext> {
 *         // Use AI facade
 *         const { result } = await execContext.aiFacade.askJson(
 *             'Analyze: {text}',
 *             schema,
 *             { variables: { text: 'hello' } },
 *             { userId: execContext.user!.id, directoryId: execContext.directory.id }
 *         );
 *
 *         // Use search facade
 *         const results = await execContext.searchFacade.search('query');
 *
 *         // Use screenshot facade
 *         const screenshot = await execContext.screenshotFacade.capture({
 *             url: 'https://example.com'
 *         });
 *
 *         return context;
 *     }
 * }
 * ```
 */
export interface StepExecutionContext {
	/**
	 * AI facade for structured AI operations.
	 * Use this for all AI calls (askJson, etc.).
	 */
	readonly aiFacade: IAiFacade;

	/**
	 * Search facade for web search and content extraction.
	 */
	readonly searchFacade: ISearchFacade;

	/**
	 * Screenshot facade for image capture.
	 */
	readonly screenshotFacade: IScreenshotFacade;

	/**
	 * Content extractor facade for specialized extraction (Notion, etc.).
	 */
	readonly contentExtractorFacade: IContentExtractorFacade;

	/**
	 * Data source facade for external data sources (Apify, etc.).
	 * Provides access to items from external data sources.
	 */
	readonly dataSourceFacade?: IDataSourceFacade;

	/**
	 * Logger instance for the step.
	 */
	readonly logger: StepLogger;

	/**
	 * Directory being processed.
	 */
	readonly directory: DirectoryReference;

	/**
	 * User context for settings resolution.
	 */
	readonly user?: UserReference;

	/**
	 * Abort signal for cancellation support.
	 */
	readonly signal?: AbortSignal;
}
