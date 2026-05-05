import type {
	IPlugin,
	IPipelinePlugin,
	IFormSchemaProvider,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	PipelineStepDefinition,
	PipelineState,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	WorkReference,
	GenerationRequest,
	ExistingItems,
	PluginManifest,
	PluginHealthCheck,
	StepStatus,
	FormFieldDefinition,
	FormFieldGroup,
	ItemData,
	AiModel,
	ConnectionValidationResult
} from '@ever-works/plugin';
import { buildSuccessPipelineResult, substituteVariables } from '@ever-works/plugin';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';

import type { ClaudeCodeStepId } from './types.js';
import { CLAUDE_CODE_STEP_IDS, DEFAULT_CLI_VERSION, DEFAULT_MAX_TURNS, BASE_TEMP_DIR } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
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
import { executeClaudeCode, type ExecuteResult } from './utils/process-runner.js';
import {
	buildSystemPromptVariables,
	buildUserPromptVariables,
	DEFAULT_SYSTEM_PROMPT,
	DEFAULT_USER_PROMPT
} from './prompt/system-prompt.js';
import { PROMPT_KEYS } from './prompt-keys.js';
import { startTaxonomyWatcher } from './utils/taxonomy-watcher.js';
import { captureScreenshots } from './utils/screenshot-capture.js';
import {
	initializeState,
	updateStepState,
	reportProgress,
	reportItemProgress,
	resolveSettings,
	resolveAuthEnv,
	buildMetrics,
	buildErrorResult,
	buildCancelledResult,
	finalizeCompletedState
} from './utils/pipeline-helpers.js';
import {
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate,
	getDefaultValues as formDefaults,
	DEFAULT_TARGET_ITEMS
} from './form-schema.js';

const CLAUDE_CODE_SUPPORTED_MODELS: readonly AiModel[] = [
	{
		id: 'sonnet',
		name: 'Claude Sonnet',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'opus',
		name: 'Claude Opus',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'haiku',
		name: 'Claude Haiku',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'claude-sonnet-4-5-20250929',
		name: 'Claude Sonnet 4.5',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'claude-opus-4-1-20250805',
		name: 'Claude Opus 4.1',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'claude-haiku-4-5-20251001',
		name: 'Claude Haiku 4.5',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	}
] as const;

const LOG_MESSAGE_MAX_LENGTH = 500;
const STEP_CONTEXT_BY_ID = new Map(
	STEP_DEFINITIONS.map((step, stepIndex) => [step.id, { stepIndex, stepName: step.name }])
);
type ClaudeCodeGenerationLog = Parameters<NonNullable<PipelineExecutionOptions['onLogEntry']>>[0];

interface ClaudeCodeLogOptions {
	readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
	readonly event: ClaudeCodeGenerationLog['event'];
	readonly level: ClaudeCodeGenerationLog['level'];
	readonly message: string;
	readonly stepId?: ClaudeCodeStepId;
	readonly durationMs?: number;
}

/**
 * Claude Code Generator Plugin
 *
 * Full pipeline plugin that delegates the entire generation to Claude Code.
 * Runs a single Claude Code session that handles web search,
 * content creation, and file generation autonomously.
 */
export class ClaudeCodePlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'claude-code';
	readonly name = 'Claude Code Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

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
				'x-widget': 'model-select',
				default: 'sonnet',
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

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Claude Code Generator plugin is ready',
			checkedAt: Date.now()
		};
	}

	async listModels(): Promise<readonly AiModel[]> {
		return CLAUDE_CODE_SUPPORTED_MODELS;
	}

	private getRealSecret(value: unknown): string | undefined {
		if (typeof value !== 'string' || !value || value.includes('••••')) return undefined;
		return value;
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		const resolved = settings || {};
		const oauthToken = this.getRealSecret(resolved.oauthToken);
		const apiKey = this.getRealSecret(resolved.apiKey);
		if (!oauthToken && !apiKey) {
			return false;
		}

		if (oauthToken) {
			const result = await this.validateCliAuth(resolved);
			return result.valid;
		}

		return this.validateApiKey(apiKey!, (resolved.model as string | undefined) || 'sonnet');
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const oauthToken = this.getRealSecret(settings.oauthToken);
		const apiKey = this.getRealSecret(settings.apiKey);

		if (!oauthToken && !apiKey) {
			return { success: false, message: 'No credentials configured. Set an API key or connect via OAuth.' };
		}

		if (oauthToken) {
			const result = await this.validateCliAuth(settings);
			return result.valid
				? { success: true, message: 'OAuth token verified.' }
				: {
						success: false,
						message: `OAuth token validation failed: ${result.detail || 'unknown error'}. Please re-run \`claude setup-token\`.`
					};
		}

		const model = (settings.model as string | undefined) || 'sonnet';
		const valid = await this.validateApiKey(apiKey!, model);
		return valid
			? { success: true, message: 'Anthropic API key verified.' }
			: { success: false, message: 'Anthropic API key is invalid or the API is unreachable.' };
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
			uiHints: {
				onboardingWizard: true,
				includeInOnboarding: true,
				onboardingPriority: 1,
				onboardingDescription: 'Connect your AI assistant to power content generation across your works.'
			},
			readme: [
				'# Claude Code Generator Plugin',
				'',
				'Full pipeline plugin that delegates the entire work generation to Claude Code. This plugin runs a single Claude Code session that autonomously handles web search, content creation, and file generation.',
				'',
				'## How it works',
				'',
				'The plugin runs 6 sequential steps:',
				'',
				'1. **Setup Claude Code** - Downloads and caches the Claude Code CLI binary',
				'2. **Prepare Context** - Creates a temporary workspace and seeds it with existing items and metadata',
				'3. **Generate Items** - Executes Claude Code CLI to research and generate work items as JSON files',
				'4. **Collect Results** - Reads the generated JSON files back to build the pipeline result',
				'5. **Capture Screenshots** - Takes screenshots for items that need images',
				'6. **Cleanup** - Removes the temporary workspace',
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
				"Enable the plugin for a work and trigger generation with `providers.pipeline: 'claude-code'`."
			].join('\n'),
			homepage: 'https://github.com/anthropics/claude-code',
			icon: {
				type: 'svg',
				value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Claude</title><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fill-rule="nonzero"></path></svg>`
			}
		};
	}

	private async validateApiKey(apiKey: string, model: string): Promise<boolean> {
		const payload = JSON.stringify({
			model,
			max_tokens: 8,
			messages: [{ role: 'user', content: 'Reply with OK.' }]
		});

		return new Promise<boolean>((resolve) => {
			const request = https.request(
				'https://api.anthropic.com/v1/messages',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(payload),
						'x-api-key': apiKey,
						'anthropic-version': '2023-06-01'
					}
				},
				(res) => {
					res.resume();
					resolve((res.statusCode || 500) < 400);
				}
			);

			request.setTimeout(10_000, () => {
				request.destroy();
				resolve(false);
			});
			request.on('error', () => resolve(false));
			request.write(payload);
			request.end();
		});
	}

	private async validateCliAuth(settings: Record<string, unknown>): Promise<{ valid: boolean; detail?: string }> {
		const oauthToken = settings.oauthToken as string | undefined;
		if (!oauthToken || oauthToken.length < 20) {
			return { valid: false, detail: 'Token is missing or too short.' };
		}

		const version = (settings.version as string) || DEFAULT_CLI_VERSION;
		let tempDir: string | null = null;

		try {
			const binaryPath = await ensureBinary(version, this.context?.logger || console);
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ever-works-claude-validate-'));

			const { promise } = executeClaudeCode({
				binaryPath,
				prompt: 'Reply with OK.',
				systemPrompt: 'Reply with the single word OK. Nothing else.',
				cwd: tempDir,
				env: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
				maxTurns: 1,
				model: settings.model as string | undefined
			});

			const result = await Promise.race([
				promise,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Validation timed out')), 30_000))
			]);

			if (result.exitCode === 0) {
				return { valid: true };
			}

			const detail = this.extractErrorDetail(result);
			return { valid: false, detail };
		} catch (err) {
			return { valid: false, detail: err instanceof Error ? err.message : 'CLI validation failed.' };
		} finally {
			if (tempDir) {
				await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
			}
		}
	}

	// ── IFormSchemaProvider ─────────────────────────────────────────────

	getFormFields(): FormFieldDefinition[] {
		return formFields();
	}

	getFormGroups(): FormFieldGroup[] {
		return formGroups();
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		return formValidate(values);
	}

	getDefaultValues(): Record<string, unknown> {
		return formDefaults(this.getFormFields());
	}

	// ── IPipelinePlugin ─────────────────────────────────────────────────

	getStepDefinitions(): readonly PipelineStepDefinition[] {
		return STEP_DEFINITIONS;
	}

	async execute(
		work: WorkReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const userId = work.user?.id;
		if (!userId) {
			return this.handleError(new Error('User ID is required'), startTime);
		}

		if (this.abortController) {
			return this.handleError(
				new Error(
					'Claude Code Generator is already executing another generation. Wait for it to finish or cancel it first.'
				),
				startTime
			);
		}

		const abortController = new AbortController();
		this.abortController = abortController;
		const signal = options?.signal ?? abortController.signal;
		const onLogEntry = options?.onLogEntry;

		this.state = initializeState();

		const logger = this.context?.logger ?? console;
		let workspacePath: string | null = null;
		let configDir: string | null = null;

		try {
			const settings = await resolveSettings(this.context, userId, work.id);
			if (settings.model) {
				logger.log(`Using model "${settings.model}" for this session as specified in settings`);
			}

			const version = (settings.version as string) || DEFAULT_CLI_VERSION;
			const maxTurns = (settings.maxTurns as number) || DEFAULT_MAX_TURNS;
			const maxBudgetUsd = settings.maxBudgetUsd as number | undefined;
			const model = settings.model as string | undefined;

			// ── Step 1: Setup Claude Code ──────────────────────────────
			const setupStepStartedAt = this.startStep('setup-claude-code', onLogEntry);
			reportProgress(onProgress, 0, 0, 'Setup Claude Code');

			const binaryPath = await ensureBinary(version, logger);
			this.completeStep('setup-claude-code', setupStepStartedAt, onLogEntry);

			if (signal.aborted) return this.handleCancel(startTime);

			// ── Step 2: Prepare Context ────────────────────────────────
			const prepareContextStepStartedAt = this.startStep('prepare-context', onLogEntry);
			reportProgress(onProgress, 1, 20, 'Prepare Context');

			configDir = path.join(BASE_TEMP_DIR, 'config', userId);
			workspacePath = await createWorkspace(userId, work.id);
			await ensureOnboardingConfig(configDir);
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				work: { name: work.name, description: work.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands,
				references: existing.references
			});
			this.completeStep('prepare-context', prepareContextStepStartedAt, onLogEntry);

			if (signal.aborted) return this.handleCancel(startTime);

			// ── Step 3: Generate Items ─────────────────────────────────
			const generateItemsStepStartedAt = this.startStep('generate-items', onLogEntry);
			reportProgress(onProgress, 2, 30, 'Generate Items');

			const promptOptions = { work, request, existing, workspacePath };
			const execContext = options?.execContext;
			const promptFacade = execContext?.promptFacade;
			const facadeOptions = { userId, workId: work.id };

			const sysTemplate = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.SYSTEM, DEFAULT_SYSTEM_PROMPT, facadeOptions)
					: DEFAULT_SYSTEM_PROMPT
			) as typeof DEFAULT_SYSTEM_PROMPT;
			const systemPrompt = substituteVariables(sysTemplate, buildSystemPromptVariables(promptOptions));

			const userTemplate = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.USER, DEFAULT_USER_PROMPT, facadeOptions)
					: DEFAULT_USER_PROMPT
			) as typeof DEFAULT_USER_PROMPT;
			const userPrompt = substituteVariables(userTemplate, buildUserPromptVariables(promptOptions));

			const authEnv = resolveAuthEnv(settings);
			const targetItems = ((request.config || {}).target_items as number) || DEFAULT_TARGET_ITEMS;

			const taxonomyWatcher = startTaxonomyWatcher({
				workspacePath,
				logger,
				onNewItem: (newItemCount) => {
					reportItemProgress(onProgress, newItemCount, targetItems, 2);
				}
			});

			let execResult: ExecuteResult;
			try {
				const { onStdoutLine, onStderrLine } = this.createClaudeCodeStreamHandlers(onLogEntry);

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
					signal,
					onStdoutLine,
					onStderrLine
				});

				this.killProcess = kill;
				execResult = await promise;
				this.killProcess = null;
			} finally {
				taxonomyWatcher.stop();
			}

			if (execResult.killed || signal.aborted) {
				this.failStep('generate-items', new Error('Cancelled'), onLogEntry);
				return this.handleCancel(startTime);
			}

			let generationWarning: string | undefined;
			if (execResult.exitCode !== 0) {
				const detail = this.extractErrorDetail(execResult);

				logger.warn(`Claude Code exited with code ${execResult.exitCode}: ${detail}`);
				generationWarning = `Claude Code finished with an error (${detail}).`;
				this.emitClaudeCodeLog({
					onLogEntry,
					stepId: 'generate-items',
					event: 'message',
					level: 'warn',
					message: generationWarning
				});
			}

			this.completeStep('generate-items', generateItemsStepStartedAt, onLogEntry);

			// ── Step 4: Collect Results ────────────────────────────────
			const collectResultsStepStartedAt = this.startStep('collect-results', onLogEntry);
			reportProgress(onProgress, 3, 85, 'Collect Results');

			const items = await readGeneratedItems(workspacePath, logger);
			const metadata = collectMetadataFromItems(items);
			this.completeStep('collect-results', collectResultsStepStartedAt, onLogEntry);

			// ── Step 5: Capture Screenshots ────────────────────────────
			const screenshotWarnings = await this.runScreenshotCapture(
				request,
				options?.execContext,
				items,
				userId,
				work.id,
				signal,
				onProgress,
				logger,
				onLogEntry
			);

			// ── Step 6: Cleanup ────────────────────────────────────────
			const cleanupStepStartedAt = this.startStep('cleanup', onLogEntry);
			reportProgress(onProgress, 5, 95, 'Cleanup');

			if (workspacePath) {
				await cleanupWorkspace(workspacePath);
				workspacePath = null;
			}
			this.completeStep('cleanup', cleanupStepStartedAt, onLogEntry);

			if (signal.aborted) {
				return this.handleCancel(startTime);
			}

			// ── Build result ───────────────────────────────────────────
			reportProgress(onProgress, 6, 100, 'Complete');

			const duration = Date.now() - startTime;
			const warnings = [...(generationWarning ? [generationWarning] : []), ...screenshotWarnings];
			this.state = finalizeCompletedState(this.state!);

			return buildSuccessPipelineResult(
				{
					items,
					categories: metadata.categories,
					tags: metadata.tags,
					brands: metadata.brands,
					collections: metadata.collections || []
				},
				{
					metrics: buildMetrics(startTime, duration, items.length),
					duration,
					stepsCompleted: this.state!.completedSteps.length,
					totalSteps: CLAUDE_CODE_STEP_IDS.length,
					state: this.state!,
					warnings: warnings.length > 0 ? warnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const runningStepId = this.getRunningStepId();
			if (runningStepId) {
				this.failStep(runningStepId, err, onLogEntry);
			}
			logger.error(`Claude Code pipeline failed: ${err.message}`);
			if (workspacePath) {
				await cleanupWorkspace(workspacePath);
			}
			return this.handleError(err, startTime);
		} finally {
			if (this.abortController === abortController) {
				this.abortController = null;
				this.killProcess = null;
			}
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

	private async runScreenshotCapture(
		request: GenerationRequest,
		execContext: PipelineExecutionOptions['execContext'],
		items: ItemData[],
		userId: string,
		workId: string,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void },
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<string[]> {
		const shouldCapture = (request.config || {}).capture_screenshots !== false;
		const screenshotFacade = execContext?.screenshotFacade;

		if (!shouldCapture || items.length === 0 || signal.aborted || !screenshotFacade) {
			this.skipStep('capture-screenshots', 'Screenshot capture skipped', onLogEntry);
			return [];
		}

		if (!screenshotFacade.isAvailable()) {
			this.skipStep(
				'capture-screenshots',
				'Screenshot provider is not configured. Enable a screenshot plugin to capture item images.',
				onLogEntry
			);
			return ['Screenshot provider is not configured. Enable a screenshot plugin to capture item images.'];
		}

		const captureScreenshotsStepStartedAt = this.startStep('capture-screenshots', onLogEntry);
		reportProgress(onProgress, 4, 87, 'Capture Screenshots');

		const { status, errors } = await captureScreenshots(items, {
			screenshotFacade,
			facadeOptions: { userId, workId },
			signal,
			logger
		});

		if (status === 'failed') {
			this.failStep('capture-screenshots', new Error(errors[0] || 'Screenshot capture failed'), onLogEntry);
		} else {
			this.completeStep('capture-screenshots', captureScreenshotsStepStartedAt, onLogEntry);
		}

		if (errors.length > 0) {
			const facadeOptions = { userId, workId };
			const providerName = await screenshotFacade.getActiveProviderName?.(facadeOptions);
			const label = providerName ? `Screenshot capture (${providerName})` : 'Screenshot capture';
			const unique = [...new Set(errors)];
			return [`${label} failed for ${errors.length} item(s): ${unique.join('; ')}`];
		}
		return [];
	}

	private createClaudeCodeStreamHandlers(onLogEntry?: PipelineExecutionOptions['onLogEntry']): {
		onStdoutLine?: (line: string) => void;
		onStderrLine?: (line: string) => void;
	} {
		if (!onLogEntry) {
			return {};
		}

		return {
			onStdoutLine: (line: string) => {
				const logEntry = this.buildClaudeCodeLogFromStdout(line);
				if (!logEntry) {
					return;
				}

				this.emitClaudeCodeLog({ onLogEntry, ...logEntry });
			},
			onStderrLine: (line: string) => {
				this.emitClaudeCodeLog({
					onLogEntry,
					stepId: 'generate-items',
					event: 'message',
					level: 'error',
					message: this.truncateLogMessage(line)
				});
			}
		};
	}

	private buildClaudeCodeLogFromStdout(line: string): Omit<ClaudeCodeLogOptions, 'onLogEntry'> | null {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			return null;
		}

		try {
			const event = JSON.parse(trimmedLine) as Record<string, unknown>;
			const type = this.extractString(event.type);

			switch (type) {
				case 'assistant': {
					const text = this.extractClaudeContentText(
						(event.message as { content?: unknown } | undefined)?.content
					);
					return text
						? {
								stepId: 'generate-items',
								event: 'message',
								level: 'info',
								message: text
							}
						: null;
				}
				case 'tool_use': {
					const toolName = this.extractString(event.tool) || this.extractString(event.name) || 'unknown';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: 'info',
						message: `Tool started: ${toolName}`
					};
				}
				case 'tool_result': {
					const toolName = this.extractString(event.tool) || this.extractString(event.name) || 'unknown';
					const toolOutput =
						this.extractString(event.result) ||
						this.extractString((event.result as { content?: unknown } | undefined)?.content);
					return {
						stepId: 'generate-items',
						event: 'message',
						level: 'info',
						message: toolOutput
							? `Tool finished: ${toolName} (${toolOutput})`
							: `Tool finished: ${toolName}`
					};
				}
				case 'result': {
					const detail =
						this.extractString(event.result) ||
						this.extractString(event.error) ||
						'Claude Code session completed';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: event.is_error === true ? 'warn' : 'info',
						message: event.is_error === true ? `Claude Code result: ${detail}` : detail
					};
				}
				case 'error': {
					const detail =
						this.extractString((event.error as { message?: unknown } | undefined)?.message) ||
						this.extractString(event.message) ||
						this.extractString(event.error) ||
						'Claude Code reported an error';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: 'error',
						message: detail
					};
				}
				default: {
					const message =
						this.extractString(event.message) ||
						this.extractString(event.summary) ||
						(type ? `Claude Code event: ${type}` : undefined);
					return message
						? {
								stepId: 'generate-items',
								event: 'message',
								level: 'info',
								message
							}
						: null;
				}
			}
		} catch {
			return {
				stepId: 'generate-items',
				event: 'message',
				level: 'info',
				message: trimmedLine
			};
		}
	}

	private extractClaudeContentText(content: unknown): string | undefined {
		if (typeof content === 'string') {
			return this.truncateLogMessage(content);
		}

		if (!Array.isArray(content)) {
			return undefined;
		}

		const text = content
			.filter((part): part is { type?: string; text?: string } => typeof part === 'object' && part !== null)
			.filter((part) => part.type === 'text' && typeof part.text === 'string')
			.map((part) => part.text!.trim())
			.filter(Boolean)
			.join(' ');

		return text ? this.truncateLogMessage(text) : undefined;
	}

	private extractString(value: unknown): string | undefined {
		if (typeof value === 'string') {
			const trimmedValue = value.trim();
			return trimmedValue ? this.truncateLogMessage(trimmedValue) : undefined;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return this.truncateLogMessage(String(value));
		}

		return undefined;
	}

	private truncateLogMessage(message: string): string {
		return message.trim().slice(0, LOG_MESSAGE_MAX_LENGTH);
	}

	private startStep(stepId: ClaudeCodeStepId, onLogEntry?: PipelineExecutionOptions['onLogEntry']): number {
		this.setState(stepId, 'running');
		this.emitClaudeCodeLog({
			onLogEntry,
			stepId,
			event: 'step_started',
			level: 'info',
			message: this.getStepName(stepId)
		});
		return Date.now();
	}

	private completeStep(
		stepId: ClaudeCodeStepId,
		startedAt: number,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'completed');
		this.emitClaudeCodeLog({
			onLogEntry,
			stepId,
			event: 'step_completed',
			level: 'info',
			message: this.getStepName(stepId),
			durationMs: Date.now() - startedAt
		});
	}

	private failStep(
		stepId: ClaudeCodeStepId,
		error: Error,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'failed', error.message);
		this.emitClaudeCodeLog({
			onLogEntry,
			stepId,
			event: 'step_failed',
			level: 'error',
			message: `${this.getStepName(stepId)}: ${this.truncateLogMessage(error.message)}`
		});
	}

	private skipStep(
		stepId: ClaudeCodeStepId,
		message: string,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'skipped' as StepStatus);
		this.emitClaudeCodeLog({
			onLogEntry,
			stepId,
			event: 'step_skipped',
			level: 'info',
			message: this.truncateLogMessage(message)
		});
	}

	private emitClaudeCodeLog({ onLogEntry, stepId, message, ...log }: ClaudeCodeLogOptions): void {
		if (!onLogEntry) {
			return;
		}

		const stepContext = stepId ? STEP_CONTEXT_BY_ID.get(stepId) : undefined;

		onLogEntry({
			timestamp: new Date().toISOString(),
			source: 'claude-code',
			message: this.truncateLogMessage(message),
			stepIndex: stepContext?.stepIndex ?? null,
			stepName: stepContext?.stepName ?? null,
			...log
		});
	}

	private getStepName(stepId: ClaudeCodeStepId): string {
		return STEP_CONTEXT_BY_ID.get(stepId)?.stepName ?? stepId;
	}

	private getRunningStepId(): ClaudeCodeStepId | undefined {
		if (!this.state) {
			return undefined;
		}

		for (const stepId of CLAUDE_CODE_STEP_IDS) {
			const status = this.state.steps.get(stepId)?.status;
			if (status === 'running') {
				return stepId;
			}
		}

		return undefined;
	}

	private extractErrorDetail(result: ExecuteResult): string {
		// When stream-json is active, stderr may be empty and stdout is NDJSON.
		// Try to find the actual error from a result event or stderr.
		if (result.stderr?.trim()) {
			return result.stderr.trim().split('\n')[0].slice(0, 500);
		}

		// Parse NDJSON stdout for a result event with error info
		if (result.stdout) {
			const lines = result.stdout.split('\n');
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					const event = JSON.parse(lines[i]);
					if (event.type === 'result' && event.is_error) {
						return (event.error || event.result || 'unknown error').slice(0, 500);
					}
					if (event.type === 'error') {
						return (
							event.error?.message ||
							event.message ||
							JSON.stringify(event.error) ||
							'unknown error'
						).slice(0, 500);
					}
				} catch {
					// not JSON
				}
			}
		}

		// No structured error found — use raw stdout as last resort
		if (result.stdout?.trim()) {
			return result.stdout.trim().split('\n')[0].slice(0, 500);
		}

		return `exit code ${result.exitCode}`;
	}

	private setState(stepId: ClaudeCodeStepId, status: StepStatus, error?: string): void {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, status, error);
		}
	}

	private handleError(error: Error, startTime: number): PipelineResult {
		const { result, state } = buildErrorResult(this.state, error, startTime);
		this.state = state;
		return result;
	}

	private handleCancel(startTime: number): PipelineResult {
		const { result, state } = buildCancelledResult(this.state, startTime);
		this.state = state;
		return result;
	}
}

export default ClaudeCodePlugin;
