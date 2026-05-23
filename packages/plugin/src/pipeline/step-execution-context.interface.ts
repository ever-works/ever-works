import type { KbContextBundleData } from '@ever-works/contracts';
import type { IAiFacade } from '../facades/ai-facade.interface.js';
import type { ISearchFacade } from '../facades/search-facade.interface.js';
import type { IScreenshotFacade } from '../facades/screenshot-facade.interface.js';
import type { IContentExtractorFacade } from '../facades/content-extractor-facade.interface.js';
import type { IDataSourceFacade } from '../facades/data-source-facade.interface.js';
import type { IPromptFacade } from '../facades/prompt-facade.interface.js';
import type { IKbToolsFacade } from '../facades/kb-tools-facade.interface.js';
import type { WorkReference, UserReference } from './generation-context.interface.js';

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
 * Provides access to facades (AI, Search, Screenshot, etc.) and utilities
 * needed during step execution.
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
	 * Prompt facade for resolving externally managed prompts.
	 * Optional — when absent, steps use their hardcoded defaults.
	 */
	readonly promptFacade?: IPromptFacade;

	/**
	 * Logger instance for the step.
	 */
	readonly logger: StepLogger;

	/**
	 * Work being processed.
	 */
	readonly work: WorkReference;

	/**
	 * User context for settings resolution.
	 */
	readonly user?: UserReference;

	/**
	 * Abort signal for cancellation support.
	 */
	readonly signal?: AbortSignal;

	/**
	 * EW-641 Phase 2/b row 32b — resolved KB context bundle for this
	 * execution, when the agent-side orchestrator has wired the agent's
	 * `KnowledgeBaseService.resolveContext(workId, { query? })` through
	 * `PipelineFacadeService.createStepExecutionContext`.
	 *
	 * Optional so deployments that haven't wired the KB resolver yet
	 * (older builds, isolated unit tests, OSS images without the agent
	 * package) keep constructing identically — the carrier is here, but
	 * the row 32c orchestrator call site is what actually populates it.
	 *
	 * Step plugins read `kbContext.alwaysInjected` / `.queryRetrieved`
	 * and feed those documents into their prompts via the row 31
	 * `formatKbContext` helper (rendered by an agent-side wrapper that
	 * exposes `format()` on its bundle).
	 */
	readonly kbContext?: KbContextBundleData;

	/**
	 * EW-641 Phase 2/d row 36c — LLM-callable KB tools facade. When
	 * present, pipeline plugins that support tool-use (agent-pipeline
	 * and friends) can build `kb_search` / `kb_read` / `kb_write` /
	 * `kb_lock` / `kb_unlock` tools via the row 36b
	 * `createKbTools()` factory and pass the resulting tool map to
	 * `streamText({ tools })`. Each tool's `execute` callback
	 * delegates to this facade.
	 *
	 * Populated by the same orchestrator pattern as `kbContext` (row
	 * 32c): pipeline executors inject the NestJS-side
	 * `KbToolsFacadeAdapter` via `@Optional()`, the
	 * `PipelineFacadeService.createStepExecutionContext` accepts a
	 * 6th positional `kbTools` argument, and the executors thread it
	 * through alongside `kbContext`.
	 *
	 * Optional so deployments that haven't wired the agent module
	 * yet (older builds, isolated unit tests, OSS images without the
	 * agent package) keep constructing identically — the carrier is
	 * here, the row-36c orchestrator call site populates it.
	 */
	readonly kbTools?: IKbToolsFacade;
}
