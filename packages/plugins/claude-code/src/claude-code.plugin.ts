import type {
	IPlugin,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	PipelineStepDefinition,
	PipelineState,
	StepState,
	IFullPipelinePlugin,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	ExecutionPlan,
	DirectoryReference,
	GenerationRequest,
	ExistingItems,
	MutableGenerationContext
} from '@ever-works/plugin';
import type { StepStatus, PipelineMetrics } from '@ever-works/plugin';

import type { ClaudeCodeStepId } from './types.js';
import { CLAUDE_CODE_STEP_IDS, DEFAULT_CLI_VERSION, DEFAULT_MAX_TURNS, BASE_TEMP_DIR } from './types.js';
import { ensureBinary } from './utils/binary-manager.js';
import {
	createWorkspace,
	seedExistingItems,
	seedMetadata,
	readGeneratedItems,
	readGeneratedMetadata,
	cleanupWorkspace,
	ensureOnboardingConfig
} from './utils/workspace-manager.js';
import { executeClaudeCode } from './utils/process-runner.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt/system-prompt.js';

/**
 * Step definitions for the Claude Code pipeline.
 * All 5 steps run sequentially.
 */
const STEP_DEFINITIONS: readonly PipelineStepDefinition<ClaudeCodeStepId>[] = [
	{
		id: 'setup-claude-code',
		name: 'Setup Claude Code',
		description: 'Download and verify the Claude Code CLI binary',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 10
	},
	{
		id: 'prepare-context',
		name: 'Prepare Context',
		description: 'Create workspace and seed existing items and metadata',
		position: { type: 'after', stepId: 'setup-claude-code' },
		dependencies: [{ stepId: 'setup-claude-code', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 5
	},
	{
		id: 'generate-items',
		name: 'Generate Items',
		description: 'Execute Claude Code CLI to research and generate items',
		position: { type: 'after', stepId: 'prepare-context' },
		dependencies: [{ stepId: 'prepare-context', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect Results',
		description: 'Read generated item files and metadata from workspace',
		position: { type: 'after', stepId: 'generate-items' },
		dependencies: [{ stepId: 'generate-items', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 5
	},
	{
		id: 'cleanup',
		name: 'Cleanup',
		description: 'Remove temporary workspace files',
		position: { type: 'last' },
		dependencies: [{ stepId: 'collect-results', required: false }],
		optional: true,
		parallelizable: false,
		estimatedDuration: 2
	}
];

/**
 * Claude Code Generator Plugin
 *
 * Full pipeline plugin that delegates the entire generation to Claude Code.
 * Instead of orchestrating 15 separate steps, this plugin runs a single Claude Code
 * session that handles web search, content creation, and file generation autonomously.
 */
export class ClaudeCodePlugin implements IPlugin, IFullPipelinePlugin {
	readonly id = 'claude-code';
	readonly name = 'Claude Code Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['full-pipeline'] as const;
	readonly configurationMode = 'user-required' as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			oauthToken: {
				type: 'string',
				title: 'OAuth Token',
				description: 'Claude Code OAuth token (from `claude setup-token`)',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_CLAUDE_CODE_OAUTH_TOKEN'
			},
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Anthropic API key (from console.anthropic.com)',
				'x-secret': true,
				'x-scope': 'user'
			},
			version: {
				type: 'string',
				title: 'CLI Version',
				description: 'Claude Code CLI version to use',
				default: DEFAULT_CLI_VERSION,
				'x-hidden': true
			},
			maxTurns: {
				type: 'integer',
				title: 'Max Turns',
				description: 'Maximum number of agentic turns',
				default: DEFAULT_MAX_TURNS,
				minimum: 1,
				maximum: 100,
				'x-hidden': true
			},
			maxBudgetUsd: {
				type: 'number',
				title: 'Max Budget (USD)',
				description: 'Maximum budget in USD per generation (optional)',
				minimum: 0,
				'x-hidden': true
			}
		},
		'x-requiredGroups': [
			{
				fields: ['oauthToken', 'apiKey'],
				message: 'Either an OAuth token or API key is required'
			}
		]
	};

	private context: PluginContext | null = null;
	private state: PipelineState<ClaudeCodeStepId> | null = null;
	private abortController: AbortController | null = null;
	private killProcess: (() => void) | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Claude Code Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const oauthToken = settings.oauthToken as string | undefined;
		const apiKey = settings.apiKey as string | undefined;

		if (!oauthToken && !apiKey) {
			return {
				valid: false,
				errors: [
					{
						path: '',
						message: 'Either an OAuth token or Anthropic API key is required',
						code: 'auth-required'
					}
				]
			};
		}

		return { valid: true };
	}

	// ── IFullPipelinePlugin ────────────────────────────────────────────

	getStepDefinitions(): readonly PipelineStepDefinition[] {
		return STEP_DEFINITIONS;
	}

	createExecutionPlan(_options?: PipelineExecutionOptions): ExecutionPlan {
		return {
			phases: CLAUDE_CODE_STEP_IDS.map((stepId, index) => ({
				index,
				stepIds: [stepId],
				parallel: false
			})),
			totalSteps: CLAUDE_CODE_STEP_IDS.length,
			estimatedDuration: STEP_DEFINITIONS.reduce((sum, s) => sum + (s.estimatedDuration ?? 0), 0)
		};
	}

	async execute(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		this.abortController = new AbortController();
		const signal = options?.signal ?? this.abortController.signal;

		// Initialize pipeline state
		this.state = this.initializeState();

		const logger = this.context?.logger ?? console;
		const userId = directory.user?.id;

		if (!userId) {
			return this.buildErrorResult(new Error('User ID is required'), startTime);
		}

		try {
			// Resolve settings
			const settings = await this.resolveSettings(userId);
			const version = (settings.version as string) || DEFAULT_CLI_VERSION;
			const maxTurns = (settings.maxTurns as number) || DEFAULT_MAX_TURNS;
			const maxBudgetUsd = settings.maxBudgetUsd as number | undefined;

			// ── Step 1: Setup Claude Code ──────────────────────────────
			this.updateStepState('setup-claude-code', 'running');
			this.reportProgress(onProgress, 0, 0, 'Setup Claude Code');

			const binaryPath = await ensureBinary(version, logger);
			this.updateStepState('setup-claude-code', 'completed');

			if (signal.aborted) return this.buildCancelledResult(startTime);

			// ── Step 2: Prepare Context ────────────────────────────────
			this.updateStepState('prepare-context', 'running');
			this.reportProgress(onProgress, 1, 20, 'Prepare Context');

			const configDir = `${BASE_TEMP_DIR}/${userId}`;
			const workspacePath = await createWorkspace(userId, directory.id);
			await ensureOnboardingConfig(configDir);
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				directory: { name: directory.name, description: directory.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands
			});
			this.updateStepState('prepare-context', 'completed');

			if (signal.aborted) return this.buildCancelledResult(startTime);

			// ── Step 3: Generate Items ─────────────────────────────────
			this.updateStepState('generate-items', 'running');
			this.reportProgress(onProgress, 2, 30, 'Generate Items');

			const promptOptions = { directory, request, existing };
			const systemPrompt = buildSystemPrompt(promptOptions);
			const userPrompt = buildUserPrompt(promptOptions);

			const authEnv = this.resolveAuthEnv(settings);

			const { promise, kill } = executeClaudeCode({
				binaryPath,
				prompt: userPrompt,
				systemPrompt,
				cwd: workspacePath,
				env: {
					...authEnv,
					CLAUDE_CODE_CONFIG_DIR: configDir
				},
				maxTurns,
				maxBudgetUsd,
				signal
			});

			this.killProcess = kill;
			const execResult = await promise;
			this.killProcess = null;

			if (execResult.killed || signal.aborted) {
				this.updateStepState('generate-items', 'failed', 'Cancelled');
				return this.buildCancelledResult(startTime);
			}

			if (execResult.exitCode !== 0) {
				const errorMsg = execResult.stderr.slice(0, 500) || `Exit code ${execResult.exitCode}`;
				logger.warn(`Claude Code exited with code ${execResult.exitCode}: ${errorMsg}`);
				// Non-zero exit is a warning, not necessarily fatal.
				// Claude Code may still have generated some items before exiting.
			}

			this.updateStepState('generate-items', 'completed');

			// ── Step 4: Collect Results ────────────────────────────────
			this.updateStepState('collect-results', 'running');
			this.reportProgress(onProgress, 3, 85, 'Collect Results');

			const items = await readGeneratedItems(workspacePath, logger);
			const metadata = await readGeneratedMetadata(workspacePath);
			this.updateStepState('collect-results', 'completed');

			// ── Step 5: Cleanup ────────────────────────────────────────
			this.updateStepState('cleanup', 'running');
			this.reportProgress(onProgress, 4, 95, 'Cleanup');

			await cleanupWorkspace(userId, directory.id);
			this.updateStepState('cleanup', 'completed');

			// ── Build result ───────────────────────────────────────────
			this.reportProgress(onProgress, 5, 100, 'Complete');

			const duration = Date.now() - startTime;
			const metrics = this.buildMetrics(startTime, duration, items.length);

			return {
				success: items.length > 0,
				items,
				categories: metadata.categories,
				tags: metadata.tags,
				brands: metadata.brands,
				metrics,
				duration,
				stepsCompleted: 5,
				totalSteps: 5,
				state: this.state!
			};
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Claude Code pipeline failed: ${err.message}`);

			// Clean up workspace on failure
			await cleanupWorkspace(userId, directory.id);

			return this.buildErrorResult(err, startTime);
		}
	}

	async cancel(): Promise<void> {
		this.abortController?.abort();
		this.killProcess?.();
		this.killProcess = null;
	}

	getState(): PipelineState<ClaudeCodeStepId> | null {
		return this.state;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private initializeState(): PipelineState<ClaudeCodeStepId> {
		const steps = new Map<ClaudeCodeStepId, StepState<ClaudeCodeStepId>>();
		for (const def of STEP_DEFINITIONS) {
			steps.set(def.id, { definition: def, status: 'pending' });
		}

		return {
			steps,
			completedSteps: [],
			failedSteps: [],
			isRunning: true,
			isCancelled: false,
			startedAt: Date.now()
		};
	}

	private updateStepState(stepId: ClaudeCodeStepId, status: StepStatus, error?: string): void {
		if (!this.state) return;

		const existing = this.state.steps.get(stepId);
		if (!existing) return;

		const now = Date.now();
		const updated: StepState<ClaudeCodeStepId> = {
			...existing,
			status,
			startedAt: status === 'running' ? now : existing.startedAt,
			completedAt: status === 'completed' || status === 'failed' ? now : undefined,
			error: error ?? existing.error
		};

		const steps = new Map(this.state.steps);
		steps.set(stepId, updated);

		const completedSteps =
			status === 'completed' ? [...this.state.completedSteps, stepId] : this.state.completedSteps;

		const failedSteps = status === 'failed' ? [...this.state.failedSteps, stepId] : this.state.failedSteps;

		this.state = {
			...this.state,
			steps,
			currentStep: status === 'running' ? stepId : this.state.currentStep,
			completedSteps,
			failedSteps
		};
	}

	private reportProgress(
		onProgress: PipelineProgressCallback | undefined,
		stepIndex: number,
		percent: number,
		stepName: string
	): void {
		onProgress?.({
			percent,
			currentStepIndex: stepIndex,
			totalSteps: CLAUDE_CODE_STEP_IDS.length,
			currentStepName: stepName
		});
	}

	private async resolveSettings(userId: string): Promise<PluginSettings> {
		if (!this.context) {
			return {};
		}
		try {
			return await this.context.getSettings('user', userId);
		} catch {
			return {};
		}
	}

	private resolveAuthEnv(settings: PluginSettings): Record<string, string> {
		const oauthToken = settings.oauthToken as string | undefined;
		const apiKey = settings.apiKey as string | undefined;

		// OAuth token takes precedence over API key
		if (oauthToken) {
			return { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
		}
		if (apiKey) {
			return { ANTHROPIC_API_KEY: apiKey };
		}
		return {};
	}

	private buildMetrics(startTime: number, duration: number, itemCount: number): PipelineMetrics {
		return {
			startTime,
			duration,
			itemsProcessed: itemCount,
			urlsExtracted: 0,
			pagesRetrieved: 0,
			itemsExtracted: itemCount,
			itemsAfterDedup: itemCount,
			steps: {}
		};
	}

	private buildErrorResult(error: Error, startTime: number): PipelineResult {
		// Mark current running step as failed
		if (this.state) {
			for (const [stepId, stepState] of this.state.steps) {
				if (stepState.status === 'running') {
					this.updateStepState(stepId, 'failed', error.message);
					break;
				}
			}
		}

		return {
			success: false,
			items: [],
			categories: [],
			tags: [],
			brands: [],
			duration: Date.now() - startTime,
			stepsCompleted: this.state?.completedSteps.length ?? 0,
			totalSteps: CLAUDE_CODE_STEP_IDS.length,
			error,
			failedStep: this.state?.failedSteps[this.state.failedSteps.length - 1],
			state: this.state ?? this.initializeState()
		};
	}

	private buildCancelledResult(startTime: number): PipelineResult {
		if (this.state) {
			this.state = {
				...this.state,
				isRunning: false,
				isCancelled: true,
				completedAt: Date.now()
			};
		}

		return {
			success: false,
			items: [],
			categories: [],
			tags: [],
			brands: [],
			duration: Date.now() - startTime,
			stepsCompleted: this.state?.completedSteps.length ?? 0,
			totalSteps: CLAUDE_CODE_STEP_IDS.length,
			error: 'Pipeline cancelled',
			state: this.state ?? this.initializeState()
		};
	}
}

export default ClaudeCodePlugin;
