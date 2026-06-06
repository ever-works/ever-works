import type {
	IPlugin,
	IPipelineModifierPlugin,
	IPipelineContext,
	ModifierBuildTimeCheck,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	PluginManifest,
	PluginHealthCheck,
	PipelineStepDefinition,
	StepExecutionOptions,
	StepProgressCallback,
	StepExecutionContext,
	IAgentMemoryStepFacade,
	AgentMemoryRecord,
	AgentMemoryContext
} from '@ever-works/plugin';

/** Step injected at the START of every pipeline run — fetches prior
 *  agent-memory context relevant to the Work and stashes it on the
 *  pipeline context for downstream steps to pick up. */
export const FETCH_CONTEXT_STEP_ID = 'memory-fetch-context';

/** Step injected at the END of every pipeline run — saves a short
 *  observation summarising what was generated, so the next run can
 *  retrieve it. */
export const SAVE_MEMORY_STEP_ID = 'memory-save';

/** Pipeline context bag — `IPipelineContext` is loosely typed; we cast
 *  to / from `Record<string, unknown>` to attach our temporary memory
 *  hints without coupling to any specific pipeline's context shape. */
type ContextBag = IPipelineContext & Record<string, unknown>;

/** Settings the modifier reads after the facade resolves the
 *  user/work/admin hierarchy. */
export interface MemoryPipelineModifierSettings {
	enabled?: boolean;
	purpose?: string;
	maxContextTokens?: number;
	saveSummary?: boolean;
}

const DEFAULT_PURPOSE = 'work-generation';
const DEFAULT_MAX_CONTEXT_TOKENS = 1500;

/**
 * Security (prompt-injection hardening): chat-template control markers that
 * some models interpret as out-of-band role/turn delimiters. Stripped from
 * untrusted values before they are embedded in the observation text that this
 * modifier persists to the agent-memory store. Mirrors the shared
 * `neutralizePromptField` / `sanitizePromptVariable` pattern used across the
 * agent package (`agents/prompt-assembler.service.ts`,
 * `services/kb-prompt-formatter.ts`, `user-research/prompts.ts`).
 */
const CHAT_TEMPLATE_MARKER_PATTERN = /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi;

/**
 * Security (prompt-injection hardening): the observation summaries built below
 * are saved verbatim to the agent-memory store and later re-fetched by
 * `runFetchContext` into `context.memoryContext`, which downstream pipeline
 * steps splice into their LLM prompts. The interpolated `work.name` and
 * `error.message` are attacker-controlled (a tenant can name a Work anything;
 * an error can echo poisoned URLs/filenames), so a value like
 * `"\nIgnore previous instructions…"` would otherwise be replayed as
 * instructions on the next run. This single-line neutralizer collapses CR/LF
 * to a space (so a value cannot start a new instruction line — this also
 * defuses Markdown headings, which only act at line-start) and strips
 * chat-template control markers (so it cannot spoof a system/user turn). The
 * summaries are single-line observations, so clean text is returned unchanged
 * and legitimate work names / error messages pass through untouched.
 */
function neutralizeMemoryField(value: string): string {
	return value.replace(/\r?\n|\r/g, ' ').replace(CHAT_TEMPLATE_MARKER_PATTERN, '');
}

/**
 * Agent-memory pipeline modifier.
 *
 * Adds two steps to any pipeline (target `['*']`):
 *
 *   1. `memory-fetch-context` (position: first) — calls
 *      `agentMemoryFacade.buildContext({...})` to get a digest of
 *      previously-saved observations for the same project / work, then
 *      attaches the result to the pipeline context as
 *      `context.memoryContext` so downstream steps that know how to use
 *      it can splice it into their prompts.
 *
 *   2. `memory-save` (position: last) — calls
 *      `agentMemoryFacade.saveMemory({...})` with a short summary of
 *      the run (item counts + any error / cancellation signal). Future
 *      runs of the same Work pick this up via step 1.
 *
 * Opt-in: the modifier's `canSkip()` returns `true` unless the
 * `enabled: boolean` setting is set on the Work (off by default). When
 * the resolved agent-memory facade is missing — e.g. the operator
 * hasn't installed `@ever-works/agentmemory-plugin` yet — the steps
 * log a warning and no-op rather than failing the whole pipeline.
 *
 * The modifier itself implements `IPipelineModifierPlugin` and
 * dispatches in `execute()` based on `options.settings.stepId`, which
 * the step-pipeline executor wires through.
 */
export class MemoryPipelineModifierPlugin implements IPlugin, IPipelineModifierPlugin {
	readonly id = 'memory-pipeline-modifier';
	readonly name = 'Agent Memory Hooks';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities = ['pipeline-modifier'] as const;
	readonly configurationMode = 'hybrid' as const;
	// Step-orchestratable pipelines only. Self-managed pipelines
	// (claude-code, codex, opencode, etc.) bypass modifier injection
	// because they route through `FullPipelineExecutorService`, so
	// listing them here would be silently ineffective (Codex P2 on
	// PR #1081). Enumerate explicitly instead of `['*']` so it's
	// obvious which pipelines pick this up.
	readonly targetPipelines = ['standard-pipeline', 'agent-pipeline'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			enabled: {
				type: 'boolean',
				title: 'Enable agent-memory hooks for this Work',
				description:
					"Inject persistent memory hooks into the Work's pipeline. When on, the pipeline fetches prior observations at the start and saves a digest at the end. Requires an agent-memory provider to be enabled (default: @ever-works/agentmemory-plugin).",
				default: false,
				'x-scope': 'work'
			},
			purpose: {
				type: 'string',
				title: 'Context purpose',
				description:
					'Hint passed to the memory backend to bias the retrieved context (e.g. "work-generation", "fix-bug", "research"). Backends that support purpose-aware retrieval will use it.',
				default: DEFAULT_PURPOSE,
				'x-scope': 'work'
			},
			maxContextTokens: {
				type: 'number',
				title: 'Max context tokens',
				description: 'Upper bound on the size of the injected memory context payload.',
				default: DEFAULT_MAX_CONTEXT_TOKENS,
				minimum: 100,
				maximum: 32_000,
				'x-scope': 'work'
			},
			saveSummary: {
				type: 'boolean',
				title: 'Save a summary at the end of the run',
				description:
					'When on, the last pipeline step saves a short observation about what was generated so the next run can recall it.',
				default: true,
				'x-scope': 'work'
			}
		},
		required: []
	};

	private context: PluginContext | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('memory-pipeline-modifier plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'memory-pipeline-modifier plugin is ready',
			checkedAt: Date.now()
		};
	}

	async validateSettings(settings: Record<string, unknown>): Promise<ValidationResult> {
		const maxTokens = settings.maxContextTokens;
		if (maxTokens !== undefined && (typeof maxTokens !== 'number' || maxTokens < 100 || maxTokens > 32_000)) {
			return {
				valid: false,
				errors: [
					{ path: 'maxContextTokens', message: '`maxContextTokens` must be a number between 100 and 32000' }
				]
			};
		}
		return { valid: true };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Injects persistent memory hooks into any work-generation pipeline — fetches prior context at the start, saves a digest at the end. Requires an agent-memory provider.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public'
		};
	}

	// ── IPipelineModifierPlugin ────────────────────────────────────────

	getStepDefinitions(): PipelineStepDefinition[] {
		return [
			{
				id: FETCH_CONTEXT_STEP_ID,
				name: 'Fetch agent-memory context',
				description: 'Retrieve persistent context for this Work from the agent-memory store.',
				position: { type: 'first' },
				optional: true,
				parallelizable: false,
				provides: ['memoryContext']
			},
			{
				id: SAVE_MEMORY_STEP_ID,
				name: 'Save agent-memory observation',
				description: 'Persist a short digest of this run to the agent-memory store for next time.',
				position: { type: 'last' },
				optional: true,
				parallelizable: false
			}
		];
	}

	async canSkip(context: IPipelineContext): Promise<boolean> {
		const settings = this.resolveSettings(context);
		// Skip the whole modifier when disabled — pipeline-builder won't
		// inject either step on this run.
		return settings.enabled !== true;
	}

	/**
	 * KB option B (PR #1087). The pipeline-builder calls this BEFORE
	 * injecting our steps, so disabling the modifier here means zero
	 * overhead on the host pipeline — no STEP_STARTED events, no step
	 * metrics, no executor branching. Decision is purely settings-based,
	 * matching the existing `canSkip(context)` semantics.
	 */
	async canSkipAtBuildTime(input: ModifierBuildTimeCheck): Promise<boolean> {
		return input.settings.enabled !== true;
	}

	async execute(
		context: IPipelineContext,
		options?: StepExecutionOptions,
		_onProgress?: StepProgressCallback
	): Promise<IPipelineContext> {
		const rawSettings = (options?.settings ?? {}) as Record<string, unknown>;
		const stepId = rawSettings.stepId as string | undefined;
		const execContext = rawSettings.execContext as StepExecutionContext | undefined;
		const settings = this.resolveSettings(context, rawSettings);

		if (!stepId) {
			// The pipeline-builder always supplies stepId when invoking a
			// modifier. Missing it points at a wiring bug — fail loud.
			throw new Error(
				'memory-pipeline-modifier: `options.settings.stepId` is required (set by step-pipeline-executor).'
			);
		}

		const logger = execContext?.logger ?? console;

		// As of PR #1087, `canSkipAtBuildTime` gates this modifier
		// before its steps are injected, so reaching `execute()` already
		// implies `settings.enabled === true`. We keep a defensive
		// check here as a safety net in case the host doesn't honour
		// canSkipAtBuildTime (older agent build, third-party orchestrator):
		// silently no-op without warning.
		if (settings.enabled !== true) {
			return context;
		}

		const memoryFacade = execContext?.agentMemoryFacade;

		if (!memoryFacade) {
			logger.warn(
				`memory-pipeline-modifier: no agent-memory facade on execContext — install and enable an agent-memory provider (e.g. @ever-works/agentmemory-plugin). Step "${stepId}" no-ops.`
			);
			return context;
		}

		// Stash execContext on the context bag so rollback() can find the
		// bound memory facade later — rollback's interface signature is
		// (context, error) without an options bag, so this is the only
		// way to thread the facade through without changing the contract.
		(context as ContextBag).__memoryModifierExecContext = execContext;

		if (stepId === FETCH_CONTEXT_STEP_ID) {
			return await this.runFetchContext(context as ContextBag, memoryFacade, settings, logger);
		}
		if (stepId === SAVE_MEMORY_STEP_ID) {
			return await this.runSaveMemory(context as ContextBag, memoryFacade, settings, logger);
		}

		throw new Error(`memory-pipeline-modifier: unknown stepId "${stepId}"`);
	}

	async validate(_context: IPipelineContext): Promise<{ valid: boolean; error?: string }> {
		return { valid: true };
	}

	/**
	 * Called by the step-pipeline-executor when the host pipeline fails
	 * or is cancelled. The `last`-positioned `memory-save` step never
	 * fires in that case (the executor breaks out of the step loop
	 * before reaching `last`), so we use rollback to persist a digest
	 * tagged `failed` / `cancelled` instead.
	 *
	 * Note: the rollback interface doesn't include `options` / `execContext`,
	 * so we recover the bound memory facade by reading it from the
	 * context bag where `execute()` stashed it on its first run. If the
	 * fetch-context step never ran (e.g. modifier disabled, or the
	 * pipeline failed before group 0), there's nothing stashed and we
	 * no-op silently.
	 */
	async rollback(context: IPipelineContext, error: Error): Promise<void> {
		const settings = this.resolveSettings(context);
		if (settings.enabled !== true) return;

		const execContext = (context as ContextBag).__memoryModifierExecContext as StepExecutionContext | undefined;
		const memoryFacade = execContext?.agentMemoryFacade;
		const logger = execContext?.logger ?? console;

		if (!memoryFacade) {
			// fetch-context didn't run, or the modifier was disabled when
			// it did. Either way there's no facade to call (and so nothing
			// was opened that needs closing).
			return;
		}

		// When the failure digest is disabled we still MUST close any
		// session this modifier opened during fetch-context — otherwise a
		// failed/cancelled run with `saveSummary: false` leaks the session
		// (Codex P2 on PR #1113).
		if (settings.saveSummary === false) {
			await this.closeSelfOpenedSession(context as ContextBag, memoryFacade, logger);
			return;
		}

		try {
			const work = (context as { work?: { id?: string; name?: string; slug?: string } }).work;
			const items = (context as { items?: unknown[] }).items;
			const isCancellation = this.looksLikeCancellation(error);

			const summary = this.buildFailureSummary(work, items, error, isCancellation);
			const tags = this.buildFailureTags(work, isCancellation);
			const sessionId = this.resolveSessionId(context as ContextBag);

			const record: AgentMemoryRecord = await memoryFacade.saveMemory(
				{
					content: summary,
					tags,
					projectId: work?.slug ?? work?.id,
					...(sessionId ? { sessionId } : {}),
					metadata: {
						workId: work?.id,
						workSlug: work?.slug,
						itemCount: Array.isArray(items) ? items.length : undefined,
						errorMessage: error.message,
						errorName: error.name,
						failedAt: new Date().toISOString()
					}
				},
				{ userId: 'bound', workId: 'bound' }
			);

			logger.log(
				`memory-rollback: saved ${isCancellation ? 'cancellation' : 'failure'} observation ${record.id} for Work "${work?.slug ?? work?.id ?? '?'}"`
			);
		} catch (rollbackError) {
			const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
			logger.warn(`memory-rollback: failed to save failure observation — ${message}`);
			// Do not rethrow — the host executor catches and demotes
			// rollback errors, but defending here too keeps the
			// invariant local.
		} finally {
			// Close the per-run session we opened (no-op when the session
			// was supplied by an orchestrator, which owns its lifecycle).
			await this.closeSelfOpenedSession(context as ContextBag, memoryFacade, logger);
		}
	}

	// ── session lifecycle ──────────────────────────────────────────────

	/**
	 * Resolve the agent-memory session id to associate this run's
	 * reads/writes with, WITHOUT opening a new one:
	 *
	 *   1. An orchestrator-supplied session (`execContext.memorySessionId`,
	 *      forwarded by the pipeline executor from
	 *      `PipelineExecutionOptions.memorySessionId`) always wins — the
	 *      caller owns that session's lifecycle, so we never close it.
	 *   2. Otherwise a session this modifier opened earlier in the same
	 *      run (stashed on the context bag by `ensureSessionId`).
	 *
	 * Returns `undefined` when neither exists yet.
	 */
	private resolveSessionId(context: ContextBag): string | undefined {
		const execContext = context.__memoryModifierExecContext as StepExecutionContext | undefined;
		if (execContext?.memorySessionId) return execContext.memorySessionId;
		return context.__memoryModifierSessionId as string | undefined;
	}

	/**
	 * Resolve an existing session id or, when none is supplied by an
	 * orchestrator, open a per-run session of our own so that the
	 * fetch-context read, the save digest, and any failure rollback all
	 * land on the SAME `agent_memory_sessions` row. Called from the
	 * first-position fetch step so the session exists for the whole run.
	 *
	 * Best-effort: a failure to open is swallowed (memory must never crash
	 * the host pipeline) and the run continues session-less.
	 */
	private async ensureSessionId(
		context: ContextBag,
		memoryFacade: IAgentMemoryStepFacade,
		logger: { log(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
	): Promise<string | undefined> {
		const existing = this.resolveSessionId(context);
		if (existing) return existing;

		try {
			const work = (context as { work?: { id?: string; slug?: string } }).work;
			const session = await memoryFacade.openSession(
				// Open in the SAME project namespace the fetch/save/rollback
				// calls use (`work.slug ?? work.id`) so the session row and
				// its memory entries live together (Codex P2 on PR #1113).
				{ projectId: work?.slug ?? work?.id, source: this.id, workId: work?.id, workSlug: work?.slug },
				// Bound facade ignores its facadeOptions — pass placeholder.
				{ userId: 'bound', workId: 'bound' }
			);
			if (session?.id) {
				context.__memoryModifierSessionId = session.id;
				context.__memoryModifierSessionSelfOpened = true;
				logger.log(`memory-session: opened session ${session.id} for Work "${work?.slug ?? work?.id ?? '?'}"`);
				return session.id;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`memory-session: failed to open session — ${message}`);
		}
		return undefined;
	}

	/**
	 * Close the session this modifier opened, exactly once, at the end of
	 * the run (success digest, save-disabled exit, or failure rollback).
	 * No-ops when the session was supplied by an orchestrator (it owns the
	 * lifecycle) or when we never opened one. Best-effort.
	 */
	private async closeSelfOpenedSession(
		context: ContextBag,
		memoryFacade: IAgentMemoryStepFacade,
		logger: { log(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
	): Promise<void> {
		if (context.__memoryModifierSessionSelfOpened !== true) return;
		const sessionId = context.__memoryModifierSessionId as string | undefined;
		// Flip the flag first so a concurrent/repeated terminal step can't
		// double-close.
		context.__memoryModifierSessionSelfOpened = false;
		if (!sessionId) return;

		try {
			await memoryFacade.closeSession(sessionId, { userId: 'bound', workId: 'bound' });
			logger.log(`memory-session: closed session ${sessionId}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`memory-session: failed to close session ${sessionId} — ${message}`);
		}
	}

	// ── step implementations ───────────────────────────────────────────

	private async runFetchContext(
		context: ContextBag,
		memoryFacade: IAgentMemoryStepFacade,
		settings: MemoryPipelineModifierSettings,
		logger: { log(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
	): Promise<IPipelineContext> {
		try {
			const work = (context as { work?: { id?: string; name?: string; slug?: string } }).work;
			const request = (context as { request?: { prompt?: string } }).request;

			// Associate this read with the run's session. Honour an
			// orchestrator-supplied session id (e.g. an agent run that
			// triggers a pipeline, forwarded via
			// StepExecutionContext.memorySessionId); otherwise open a
			// per-run session of our own so the fetch read, the save
			// digest, and any failure rollback all share one session row.
			const sessionId = await this.ensureSessionId(context, memoryFacade, logger);

			const ctx: AgentMemoryContext = await memoryFacade.buildContext(
				{
					query: request?.prompt,
					purpose: settings.purpose ?? DEFAULT_PURPOSE,
					projectId: work?.slug ?? work?.id,
					maxTokens: settings.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
					...(sessionId ? { sessionId } : {})
				},
				// Bound facade ignores its facadeOptions — pass placeholder.
				{ userId: 'bound', workId: 'bound' }
			);

			if (ctx?.content) {
				(context as ContextBag).memoryContext = ctx;
				logger.log(
					`memory-fetch-context: injected ${ctx.approxTokens ?? '~'} tokens of prior memory for Work "${work?.slug ?? work?.id ?? '?'}"`
				);
			} else {
				logger.log('memory-fetch-context: no prior memory found');
			}

			return context;
		} catch (error) {
			// Memory failures must NEVER crash the host pipeline — log
			// and keep going. The Work generation is the main job here.
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`memory-fetch-context: failed to fetch context — ${message}`);
			return context;
		}
	}

	private async runSaveMemory(
		context: ContextBag,
		memoryFacade: IAgentMemoryStepFacade,
		settings: MemoryPipelineModifierSettings,
		logger: { log(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
	): Promise<IPipelineContext> {
		if (settings.saveSummary === false) {
			logger.log('memory-save: saveSummary disabled — skipping');
			await this.closeSelfOpenedSession(context, memoryFacade, logger);
			return context;
		}

		try {
			const work = (context as { work?: { id?: string; name?: string; slug?: string } }).work;
			const items = (context as { items?: unknown[] }).items;

			// `memory-save` only runs on success — failure / cancellation
			// digests are persisted via `rollback()` instead. Codex P2 on
			// PR #1081 spotted that the failed/cancelled branches were
			// unreachable at this step's call site.
			const summary = this.buildSummary(work, items);
			const tags = this.buildTags(work);
			const sessionId = this.resolveSessionId(context);

			const record: AgentMemoryRecord = await memoryFacade.saveMemory(
				{
					content: summary,
					tags,
					projectId: work?.slug ?? work?.id,
					...(sessionId ? { sessionId } : {}),
					metadata: {
						workId: work?.id,
						workSlug: work?.slug,
						itemCount: Array.isArray(items) ? items.length : undefined,
						completedAt: new Date().toISOString()
					}
				},
				{ userId: 'bound', workId: 'bound' }
			);

			logger.log(`memory-save: saved observation ${record.id} for Work "${work?.slug ?? work?.id ?? '?'}"`);
			await this.closeSelfOpenedSession(context, memoryFacade, logger);
			return context;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`memory-save: failed to save observation — ${message}`);
			await this.closeSelfOpenedSession(context, memoryFacade, logger);
			return context;
		}
	}

	// ── helpers ────────────────────────────────────────────────────────

	private resolveSettings(
		context: IPipelineContext,
		override?: Record<string, unknown>
	): MemoryPipelineModifierSettings {
		const fromContext = (context as { stepSettings?: Record<string, Record<string, unknown>> }).stepSettings?.[
			this.id
		];
		const merged = { ...(fromContext ?? {}), ...(override ?? {}) };
		const out: MemoryPipelineModifierSettings = {};
		if (typeof merged.enabled === 'boolean') out.enabled = merged.enabled;
		if (typeof merged.purpose === 'string' && merged.purpose) out.purpose = merged.purpose;
		if (typeof merged.maxContextTokens === 'number') out.maxContextTokens = merged.maxContextTokens;
		if (typeof merged.saveSummary === 'boolean') out.saveSummary = merged.saveSummary;
		return out;
	}

	private buildSummary(
		work: { id?: string; name?: string; slug?: string } | undefined,
		items: unknown[] | undefined
	): string {
		// Security: neutralize the attacker-controlled work name before it is
		// persisted to memory and later replayed into downstream LLM prompts.
		const workLabel = neutralizeMemoryField(work?.name ?? work?.slug ?? work?.id ?? 'unknown Work');
		const count = Array.isArray(items) ? items.length : 0;
		return `Work "${workLabel}" — pipeline completed with ${count} item${count === 1 ? '' : 's'}.`;
	}

	private buildTags(work: { id?: string; slug?: string } | undefined): readonly string[] {
		const tags: string[] = ['pipeline-run'];
		if (work?.slug) tags.push(`work:${work.slug}`);
		else if (work?.id) tags.push(`work-id:${work.id}`);
		return tags;
	}

	private buildFailureSummary(
		work: { id?: string; name?: string; slug?: string } | undefined,
		items: unknown[] | undefined,
		error: Error,
		isCancellation: boolean
	): string {
		// Security: both the work name and the error message are
		// attacker-controlled (a tenant names the Work; an error can echo a
		// poisoned URL/filename). Neutralize before persisting to memory so the
		// stored failure observation cannot inject instructions when a later run
		// fetches it into the LLM prompt context.
		const workLabel = neutralizeMemoryField(work?.name ?? work?.slug ?? work?.id ?? 'unknown Work');
		const count = Array.isArray(items) ? items.length : 0;
		const verb = isCancellation ? 'cancelled' : 'failed';
		const trimmedMessage = neutralizeMemoryField(error.message ?? '').slice(0, 240);
		const itemNote = count > 0 ? ` (${count} item${count === 1 ? '' : 's'} produced before stop)` : '';
		return `Work "${workLabel}" — pipeline ${verb}${itemNote}: ${trimmedMessage}`;
	}

	private buildFailureTags(
		work: { id?: string; slug?: string } | undefined,
		isCancellation: boolean
	): readonly string[] {
		// `let` because we push into this — matches the team's "const
		// for non-mutated values" rule (greptile P2 on PR #1082).
		// eslint-disable-next-line prefer-const
		let tags: string[] = ['pipeline-run', isCancellation ? 'cancelled' : 'failed'];
		if (work?.slug) tags.push(`work:${work.slug}`);
		else if (work?.id) tags.push(`work-id:${work.id}`);
		return tags;
	}

	private looksLikeCancellation(error: Error): boolean {
		// step-pipeline-executor builds the cancellation error with the
		// "Pipeline cancelled" prefix. We also catch `AbortError` for
		// callers that wrap the signal directly.
		const name = error.name?.toLowerCase() ?? '';
		const message = error.message?.toLowerCase() ?? '';
		return name === 'aborterror' || message.includes('cancelled') || message.includes('canceled');
	}
}
