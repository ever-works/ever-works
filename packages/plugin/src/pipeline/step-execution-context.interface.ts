import type { KbContextBundleData } from '@ever-works/contracts';
import type { IAiFacade } from '../facades/ai-facade.interface.js';
import type { ISearchFacade } from '../facades/search-facade.interface.js';
import type { IScreenshotFacade } from '../facades/screenshot-facade.interface.js';
import type { IContentExtractorFacade } from '../facades/content-extractor-facade.interface.js';
import type { IDataSourceFacade } from '../facades/data-source-facade.interface.js';
import type { IPromptFacade } from '../facades/prompt-facade.interface.js';
import type { IKbToolsFacade } from '../facades/kb-tools-facade.interface.js';
import type { IAgentMemoryStepFacade } from '../facades/agent-memory-facade.interface.js';
import type { WorkReference, UserReference } from './generation-context.interface.js';
import type { RuntimeEnvironmentData } from './runtime-environment.js';

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

	/**
	 * Agent-memory facade (PR follow-up to #1073). When present, pipeline
	 * steps that opt in (e.g. the `memory-pipeline-modifier` plugin) can
	 * fetch persistent context at the start of a run and save observations
	 * at the end. Optional so OSS builds without the `agentmemory` plugin
	 * installed — or operators who haven't enabled it for the Work —
	 * keep constructing `execContext` identically. Callers are
	 * responsible for null-checking before use.
	 */
	readonly agentMemoryFacade?: IAgentMemoryStepFacade;

	/**
	 * Optional agent-memory session id supplied by the orchestrator that
	 * invoked the pipeline (e.g. `AgentRunService` already opens a
	 * session per run via `AgentMemoryFacadeService.openSession`). When
	 * set, pipeline modifiers/steps that touch agent-memory MUST associate
	 * their `saveMemory` / `buildContext` calls with this session instead
	 * of opening one of their own, so the orchestrator and pipeline share
	 * the same `agent_memory_sessions` row.
	 *
	 * Carrier-only — populated by `PipelineFacadeService.createStepExecutionContext`.
	 * Optional: pipelines run from non-agent surfaces (Work generation
	 * tasks, manual triggers, OSS builds without `agentmemory-plugin`)
	 * leave it `undefined` and the memory modifier falls back to its
	 * default per-run association (no explicit session id).
	 */
	readonly memorySessionId?: string;

	/**
	 * Memory recall preamble block (memory upgrades M3). A fully fenced,
	 * neutralized `<agent_memory>…</agent_memory>` block resolved ONCE at
	 * dispatch by the agent-side orchestrator (`FullPipelineExecutorService`
	 * → shared `resolveMemoryRecall` helper) from the Work's agent-memory
	 * provider. Self-managed pipeline plugins (claude-code, codex,
	 * opencode, claude-managed-agent) splice it VERBATIM into their
	 * session preamble / system prompt — no per-plugin formatting,
	 * neutralizing, or truncation: the helper is the single trust
	 * boundary for recalled memory content.
	 *
	 * Optional carrier (same posture as `kbContext` / `memorySessionId`):
	 * absent when no agent-memory provider is enabled, when the Work's
	 * `memoryRecallEnabled` toggle is off, or on older orchestrators —
	 * plugins must treat `undefined` as "nothing to splice".
	 */
	readonly memoryRecall?: string;

	/**
	 * Environments — the resolved runtime Environment for this run, when the
	 * orchestrator that dispatched the pipeline knows the run's Agent and
	 * that Agent has a published Environment assigned
	 * (`agents.environmentId` → `environments` row → this plain object).
	 *
	 * Same optional-carrier posture as `kbContext` / `memoryRecall`:
	 * absent when no Agent is in play (plain Work-generation runs), when
	 * the Agent has no Environment, or on older orchestrators — plugins
	 * MUST treat `undefined` as "behave exactly as before Environments
	 * existed" (e.g. claude-managed-agent keeps its
	 * `CLAUDE_MANAGED_AGENT_EGRESS_HOSTS` env-var fallback).
	 */
	readonly runtimeEnvironment?: RuntimeEnvironmentData;
}
