import type {
	IPlugin,
	IPipelineModifierPlugin,
	IPipelineContext,
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

/** Minimal shape of the cancellation marker some pipelines stash on
 *  the context bag. Pipelines use slightly different shapes; we only
 *  care about a `code` field. */
interface CancellationLike {
	readonly code?: string;
	readonly message?: string;
}

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
	readonly targetPipelines = ['*'] as const;

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

		const memoryFacade = execContext?.agentMemoryFacade;
		const logger = execContext?.logger ?? console;

		if (!memoryFacade) {
			logger.warn(
				`memory-pipeline-modifier: no agent-memory facade on execContext — install and enable an agent-memory provider (e.g. @ever-works/agentmemory-plugin). Step "${stepId}" no-ops.`
			);
			return context;
		}

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

			const ctx: AgentMemoryContext = await memoryFacade.buildContext(
				{
					query: request?.prompt,
					purpose: settings.purpose ?? DEFAULT_PURPOSE,
					projectId: work?.slug ?? work?.id,
					maxTokens: settings.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
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
			return context;
		}

		try {
			const work = (context as { work?: { id?: string; name?: string; slug?: string } }).work;
			const items = (context as { items?: unknown[] }).items;
			const cancellation = (context as { cancellationError?: CancellationLike }).cancellationError;
			const errorMessage = (context as { errorMessage?: string }).errorMessage;

			const summary = this.buildSummary(work, items, cancellation, errorMessage);
			const tags = this.buildTags(work, items, cancellation, errorMessage);

			const record: AgentMemoryRecord = await memoryFacade.saveMemory(
				{
					content: summary,
					tags,
					projectId: work?.slug ?? work?.id,
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
			return context;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`memory-save: failed to save observation — ${message}`);
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
		items: unknown[] | undefined,
		cancellation: CancellationLike | undefined,
		errorMessage: string | undefined
	): string {
		const workLabel = work?.name ?? work?.slug ?? work?.id ?? 'unknown Work';
		if (cancellation) {
			const code: string = cancellation.code ?? 'unknown';
			return `Work "${workLabel}" — generation cancelled (${code}).`;
		}
		if (errorMessage) {
			return `Work "${workLabel}" — generation failed: ${errorMessage.slice(0, 240)}`;
		}
		const count = Array.isArray(items) ? items.length : 0;
		return `Work "${workLabel}" — pipeline completed with ${count} item${count === 1 ? '' : 's'}.`;
	}

	private buildTags(
		work: { id?: string; slug?: string } | undefined,
		_items: unknown[] | undefined,
		cancellation: CancellationLike | undefined,
		errorMessage: string | undefined
	): readonly string[] {
		const tags: string[] = ['pipeline-run'];
		if (work?.slug) tags.push(`work:${work.slug}`);
		else if (work?.id) tags.push(`work-id:${work.id}`);
		if (cancellation) tags.push('cancelled');
		if (errorMessage) tags.push('failed');
		return tags;
	}
}
