import type {
	IPlugin,
	IPipelinePlugin,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	PipelineStepDefinition,
	PipelineState,
	StepState,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	DirectoryReference,
	GenerationRequest,
	ExistingItems,
	MutableGenerationContext,
	PluginManifest,
	PluginHealthCheck
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
	collectMetadataFromItems,
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
 * This plugin runs a single Claude Code session that handles web search,
 * content creation, and file generation autonomously.
 */
export class ClaudeCodePlugin implements IPlugin, IPipelinePlugin {
	readonly id = 'claude-code';
	readonly name = 'Claude Code Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline'] as const;
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
			},
			model: {
				type: 'string',
				title: 'Model',
				'x-scope': 'global',
				description:
					"Model for the session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-5-20250929')."
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

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Claude Code Generator plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Full pipeline plugin that delegates the entire generation to Claude Code',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			selectableProviderCategories: ['screenshot'],
			readme: [
				'# Claude Code Generator Plugin',
				'',
				'Full pipeline plugin that delegates the entire directory generation to Claude Code. This plugin runs a single Claude Code session that autonomously handles web search, content creation, and file generation.',
				'',
				'## How it works',
				'',
				'The plugin runs 5 sequential steps:',
				'',
				'1. **Setup Claude Code** - Downloads and caches the Claude Code CLI binary',
				'2. **Prepare Context** - Creates a temporary workspace and seeds it with existing items and metadata',
				'3. **Generate Items** - Executes Claude Code CLI to research and generate directory items as JSON files',
				'4. **Collect Results** - Reads the generated JSON files back to build the pipeline result',
				'5. **Cleanup** - Removes the temporary workspace',
				'',
				'## Settings',
				'',
				'| Setting        | Description                       |',
				'| -------------- | --------------------------------- |',
				'| `oauthToken`   | Claude Code OAuth token           |',
				'| `apiKey`       | Anthropic API key                 |',
				'',
				'### Authentication',
				'',
				'At least one of `oauthToken` or `apiKey` must be provided. OAuth token takes precedence.',
				'',
				'**OAuth Token** (recommended):',
				'',
				'```bash',
				'claude setup-token',
				'```',
				'',
				'**API Key**:',
				'Get one from [console.anthropic.com](https://console.anthropic.com)',
				'## Usage',
				'',
				"Enable the plugin for a directory and trigger generation with `providers.pipeline: 'claude-code'`."
			].join('\n'),
			homepage: 'https://github.com/anthropics/claude-code',
			icon: {
				type: 'svg',
				value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Claude</title><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fill-rule="nonzero"></path></svg>`
			}
		};
	}

	// ── IPipelinePlugin ─────────────────────────────────────────────────

	getStepDefinitions(): readonly PipelineStepDefinition[] {
		return STEP_DEFINITIONS;
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
			const settings = await this.resolveSettings(userId, directory.id);
			if (settings.model) {
				logger.log(`Using model "${settings.model}" for this session as specified in settings`);
			}

			const version = (settings.version as string) || DEFAULT_CLI_VERSION;
			const maxTurns = (settings.maxTurns as number) || DEFAULT_MAX_TURNS;
			const maxBudgetUsd = settings.maxBudgetUsd as number | undefined;
			const model = settings.model as string | undefined;

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

			const promptOptions = { directory, request, existing, workspacePath };
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
				model,
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
				const errorMsg =
					(execResult.stderr || execResult.stdout).slice(0, 500) || `Exit code ${execResult.exitCode}`;
				logger.warn(`Claude Code exited with code ${execResult.exitCode}: ${errorMsg}`);
				// Non-zero exit is a warning, not necessarily fatal.
				// Claude Code may still have generated some items before exiting.
			}

			this.updateStepState('generate-items', 'completed');

			// ── Step 4: Collect Results ────────────────────────────────
			this.updateStepState('collect-results', 'running');
			this.reportProgress(onProgress, 3, 85, 'Collect Results');

			const items = await readGeneratedItems(workspacePath, logger);
			const metadata = collectMetadataFromItems(items);
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

	private async resolveSettings(userId: string, directoryId: string): Promise<PluginSettings> {
		if (!this.context) {
			return {};
		}
		try {
			const [userSettings, directorySettings] = await Promise.all([
				this.context.getSettings('user', userId),
				this.context.getSettings('directory', directoryId)
			]);

			for (const key in directorySettings) {
				if (directorySettings[key]) {
					userSettings[key] = directorySettings[key];
				}
			}

			return userSettings;
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
