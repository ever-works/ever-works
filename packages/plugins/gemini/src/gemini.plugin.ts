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
	DirectoryReference,
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

import type { GeminiStepId } from './types.js';
import { GEMINI_STEP_IDS, DEFAULT_CLI_VERSION, BASE_TEMP_DIR, DEFAULT_MODEL } from './types.js';
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
import { executeGemini, type ExecuteResult } from './utils/process-runner.js';
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

const GEMINI_SUPPORTED_MODELS: readonly AiModel[] = [
	{
		id: 'gemini-3.1-pro-preview',
		name: 'Gemini 3.1 Pro (Preview)',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'gemini-3.1-flash-lite-preview',
		name: 'Gemini 3.1 Flash-Lite (Preview)',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'gemini-3-flash-preview',
		name: 'Gemini 3 Flash (Preview)',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'gemini-2.5-pro',
		name: 'Gemini 2.5 Pro',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'gemini-2.5-flash',
		name: 'Gemini 2.5 Flash',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'gemini-2.5-flash-lite',
		name: 'Gemini 2.5 Flash-Lite',
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
type GeminiGenerationLog = Parameters<NonNullable<PipelineExecutionOptions['onLogEntry']>>[0];

interface GeminiLogOptions {
	readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
	readonly event: GeminiGenerationLog['event'];
	readonly level: GeminiGenerationLog['level'];
	readonly message: string;
	readonly stepId?: GeminiStepId;
	readonly durationMs?: number;
}

function buildIsolatedGeminiEnv(configDir: string, env: Record<string, string>): Record<string, string> {
	return {
		...env,
		HOME: configDir,
		XDG_CONFIG_HOME: path.join(configDir, '.config'),
		XDG_DATA_HOME: path.join(configDir, '.local', 'share'),
		XDG_CACHE_HOME: path.join(configDir, '.cache'),
		GEMINI_CONFIG_DIR: configDir
	};
}

/**
 * Gemini Generator Plugin
 *
 * Full pipeline plugin that delegates the entire generation to Gemini CLI.
 * Runs a single Gemini CLI session that handles web search,
 * content creation, and file generation autonomously.
 */
export class GeminiPlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'gemini';
	readonly name = 'Gemini Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			authMode: {
				type: 'string',
				title: 'Authentication Mode',
				description:
					'Use `api-key` for Google AI Studio keys or `vertex` for Google Cloud / Vertex AI authentication.',
				default: 'api-key',
				enum: ['api-key', 'vertex'],
				'x-scope': 'user'
			},
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Gemini API key from Google AI Studio.',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_GEMINI_API_KEY',
				'x-showIf': { field: 'authMode', value: 'api-key' }
			},
			googleCloudProject: {
				type: 'string',
				title: 'Google Cloud Project',
				description: 'Required for Vertex AI mode.',
				'x-scope': 'user',
				'x-showIf': { field: 'authMode', value: 'vertex' }
			},
			googleCloudLocation: {
				type: 'string',
				title: 'Google Cloud Location',
				description: 'Required for Vertex AI mode, for example `us-central1`.',
				default: 'us-central1',
				'x-scope': 'user',
				'x-showIf': { field: 'authMode', value: 'vertex' }
			},
			version: {
				type: 'string',
				title: 'CLI Version',
				description: 'Gemini CLI version to use',
				default: DEFAULT_CLI_VERSION,
				'x-hidden': true
			},
			model: {
				type: 'string',
				title: 'Model',
				'x-scope': 'global',
				'x-widget': 'model-select',
				default: DEFAULT_MODEL,
				description: 'Gemini model to use for generation.'
			}
		}
	};

	private context: PluginContext | null = null;
	private state: PipelineState<GeminiStepId> | null = null;
	private abortController: AbortController | null = null;
	private killProcess: (() => void) | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Gemini Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Gemini Generator plugin is ready',
			checkedAt: Date.now()
		};
	}

	async listModels(): Promise<readonly AiModel[]> {
		return GEMINI_SUPPORTED_MODELS;
	}

	private getRealSecret(value: unknown): string | undefined {
		if (typeof value !== 'string' || !value || value.includes('••••')) return undefined;
		return value;
	}

	private resolveAuthMode(settings: Record<string, unknown>): 'api-key' | 'vertex' {
		const value = settings.authMode;
		return value === 'vertex' ? 'vertex' : 'api-key';
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		const resolved = settings || {};
		const authMode = this.resolveAuthMode(resolved);
		if (authMode === 'api-key') {
			const apiKey = this.getRealSecret(resolved.apiKey);
			return apiKey
				? this.validateApiKey(apiKey, (resolved.model as string | undefined) || DEFAULT_MODEL)
				: false;
		}

		if (authMode === 'vertex') {
			const result = await this.validateCliAuth(resolved);
			return result.valid;
		}

		return false;
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const authMode = this.resolveAuthMode(settings);
		if (authMode === 'api-key') {
			const apiKey = this.getRealSecret(settings.apiKey);
			if (!apiKey) {
				return { success: false, message: 'No Gemini API key configured.' };
			}
			const model = (settings.model as string | undefined) || DEFAULT_MODEL;
			const valid = await this.validateApiKey(apiKey, model);
			return valid
				? { success: true, message: 'Gemini API key verified.' }
				: { success: false, message: 'Gemini API key is invalid or the API is unreachable.' };
		}

		if (authMode === 'vertex') {
			const result = await this.validateCliAuth(settings);
			return result.valid
				? { success: true, message: 'Vertex AI authentication verified.' }
				: { success: false, message: result.detail || 'Vertex AI authentication is not configured correctly.' };
		}

		return { success: false, message: 'Gemini authentication is not configured correctly.' };
	}

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		const errors: Array<{ path: string; message: string }> = [];
		const authMode = settings.authMode;

		if (authMode !== undefined && authMode !== 'api-key' && authMode !== 'vertex') {
			errors.push({
				path: 'authMode',
				message: 'Authentication mode must be "api-key" or "vertex"'
			});
		}

		if (settings.apiKey !== undefined && typeof settings.apiKey !== 'string') {
			errors.push({ path: 'apiKey', message: 'API key must be a string when provided' });
		}
		if (settings.googleCloudProject !== undefined && typeof settings.googleCloudProject !== 'string') {
			errors.push({ path: 'googleCloudProject', message: 'Google Cloud project must be a string when provided' });
		}
		if (settings.googleCloudLocation !== undefined && typeof settings.googleCloudLocation !== 'string') {
			errors.push({
				path: 'googleCloudLocation',
				message: 'Google Cloud location must be a string when provided'
			});
		}
		if (settings.model !== undefined && typeof settings.model !== 'string') {
			errors.push({ path: 'model', message: 'Model must be a string when provided' });
		}
		if (settings.version !== undefined && typeof settings.version !== 'string') {
			errors.push({ path: 'version', message: 'CLI version must be a string when provided' });
		}

		if (authMode === 'api-key') {
			const apiKey = settings.apiKey;
			if (typeof apiKey !== 'string' || apiKey.trim() === '') {
				errors.push({ path: 'apiKey', message: 'API key is required when authMode is "api-key"' });
			}
		}

		if (authMode === 'vertex') {
			if (typeof settings.googleCloudProject !== 'string' || settings.googleCloudProject.trim() === '') {
				errors.push({
					path: 'googleCloudProject',
					message: 'Google Cloud project is required when authMode is "vertex"'
				});
			}

			if (typeof settings.googleCloudLocation !== 'string' || settings.googleCloudLocation.trim() === '') {
				errors.push({
					path: 'googleCloudLocation',
					message: 'Google Cloud location is required when authMode is "vertex"'
				});
			}
		}

		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Full pipeline plugin that delegates the entire generation to Gemini CLI',
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
				onboardingDescription: 'Connect your AI assistant to power content generation across your directories.'
			},
			readme: [
				'# Gemini Generator Plugin',
				'',
				'Use Gemini as the pipeline engine for directory generation inside Ever Works.',
				'',
				'Gemini researches sources, generates structured directory items, and returns the finished results to Ever Works as a complete pipeline run.',
				'',
				'Choose this plugin when you want Gemini to handle the full research and generation workflow for a directory.',
				'',
				'## What It Does',
				'',
				'- Researches sources for the current directory topic.',
				'- Generates structured item data for Ever Works.',
				'- Reuses your directory context and existing items during generation.',
				'- Can work with screenshot providers for item imagery.',
				'',
				'## Authentication',
				'',
				'- **API Key**: connect with a Google AI Studio Gemini API key.',
				'- **Vertex AI**: connect with Google Cloud project settings for Vertex AI.',
				'',
				'Authentication is configured from Ever Works user settings rather than shared host login state.',
				'The runtime uses an isolated per-user Gemini home/config directory instead of the machine user home.',
				'## Usage',
				'',
				'1. Choose API Key or Vertex AI authentication.',
				'2. Save the required Gemini settings.',
				'3. Enable the plugin for a directory.',
				'4. Select `gemini` as the pipeline provider for generation.'
			].join('\n'),
			homepage: 'https://github.com/google-gemini/gemini-cli',
			icon: {
				type: 'svg',
				value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Gemini</title><path d="M12 1.75l1.88 5.37 5.37 1.88-5.37 1.88L12 16.25l-1.88-5.37-5.37-1.88 5.37-1.88L12 1.75z" fill="#4285F4"/><path d="M18.5 12.25l.95 2.8 2.8.95-2.8.95-.95 2.8-.95-2.8-2.8-.95 2.8-.95.95-2.8z" fill="#34A853"/><path d="M6.25 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" fill="#FBBC05"/></svg>`
			}
		};
	}

	private async validateApiKey(apiKey: string, model: string): Promise<boolean> {
		const payload = JSON.stringify({
			contents: [{ parts: [{ text: 'Reply with OK.' }] }]
		});

		return new Promise<boolean>((resolve) => {
			const request = https.request(
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(payload)
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
		const authEnv = resolveAuthEnv(settings);

		const version = (settings.version as string) || DEFAULT_CLI_VERSION;
		let tempDir: string | null = null;
		let killProcess: (() => void) | null = null;

		try {
			const cliCommand = ensureBinary(version, this.context?.logger || console);
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ever-works-gemini-validate-'));
			const configDir = path.join(tempDir, 'config-home');
			const workspacePath = path.join(tempDir, 'workspace');
			await fs.mkdir(workspacePath, { recursive: true });
			await ensureOnboardingConfig(configDir);

			const execution = executeGemini({
				command: cliCommand.command,
				commandArgs: cliCommand.args,
				prompt: 'Reply with OK.',
				systemPrompt: 'Reply with the single word OK. Nothing else.',
				cwd: workspacePath,
				env: buildIsolatedGeminiEnv(configDir, authEnv),
				model: settings.model as string | undefined
			});
			killProcess = execution.kill;

			const result = await Promise.race([
				execution.promise,
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
			killProcess?.();
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
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const userId = directory.user?.id;
		if (!userId) {
			return this.handleError(new Error('User ID is required'), startTime);
		}

		if (this.abortController) {
			return this.handleError(
				new Error(
					'Gemini Generator is already executing another generation. Wait for it to finish or cancel it first.'
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
			const settings = await resolveSettings(this.context, userId, directory.id);
			if (settings.model) {
				logger.log(`Using model "${settings.model}" for this session as specified in settings`);
			}

			const version = (settings.version as string) || DEFAULT_CLI_VERSION;
			const model = settings.model as string | undefined;
			// ── Step 1: Setup Gemini CLI ──────────────────────────────
			const setupStepStartedAt = this.startStep('setup-gemini', onLogEntry);
			reportProgress(onProgress, 0, 0, 'Setup Gemini CLI');

			const cliCommand = ensureBinary(version, logger);
			this.completeStep('setup-gemini', setupStepStartedAt, onLogEntry);

			if (signal.aborted) return this.handleCancel(startTime);

			// ── Step 2: Prepare Context ────────────────────────────────
			const prepareContextStepStartedAt = this.startStep('prepare-context', onLogEntry);
			reportProgress(onProgress, 1, 20, 'Prepare Context');

			configDir = path.join(BASE_TEMP_DIR, 'config', userId);
			workspacePath = await createWorkspace(userId, directory.id);
			await ensureOnboardingConfig(configDir);
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				directory: { name: directory.name, description: directory.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands
			});
			this.completeStep('prepare-context', prepareContextStepStartedAt, onLogEntry);

			if (signal.aborted) {
				if (workspacePath) {
					await cleanupWorkspace(workspacePath);
					workspacePath = null;
				}
				return this.handleCancel(startTime);
			}

			// ── Step 3: Generate Items ─────────────────────────────────
			const generateItemsStepStartedAt = this.startStep('generate-items', onLogEntry);
			reportProgress(onProgress, 2, 30, 'Generate Items');

			const promptOptions = { directory, request, existing, workspacePath };
			const execContext = options?.execContext;
			const promptFacade = execContext?.promptFacade;
			const facadeOptions = { userId, directoryId: directory.id };

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
				const { onStdoutLine, onStderrLine } = this.createGeminiStreamHandlers(onLogEntry);
				const executionEnv = buildIsolatedGeminiEnv(configDir, authEnv);

				const { promise, kill } = executeGemini({
					command: cliCommand.command,
					commandArgs: cliCommand.args,
					prompt: userPrompt,
					systemPrompt,
					cwd: workspacePath,
					env: executionEnv,
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
				if (workspacePath) {
					await cleanupWorkspace(workspacePath);
					workspacePath = null;
				}
				return this.handleCancel(startTime);
			}

			let generationWarning: string | undefined;
			if (execResult.exitCode !== 0) {
				const detail = this.extractErrorDetail(execResult);

				logger.warn(`Gemini CLI exited with code ${execResult.exitCode}: ${detail}`);
				generationWarning = `Gemini CLI finished with an error (${detail}).`;
				this.emitGeminiLog({
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

			if (items.length === 0) {
				const stderrExcerpt = execResult.stderr?.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
				const stdoutExcerpt = execResult.stdout?.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
				const cliParts = [
					stderrExcerpt ? `stderr: ${stderrExcerpt}` : '',
					stdoutExcerpt ? `stdout: ${stdoutExcerpt}` : ''
				].filter(Boolean);
				const cliSummary = cliParts.length > 0 ? ` Gemini output excerpt: ${cliParts.join(' ; ')}.` : '';
				throw new Error(
					`Gemini CLI completed without producing any valid item JSON files in the workspace.${cliSummary}`
				);
			}

			const metadata = collectMetadataFromItems(items);
			this.completeStep('collect-results', collectResultsStepStartedAt, onLogEntry);

			// ── Step 5: Capture Screenshots ────────────────────────────
			const screenshotWarnings = await this.runScreenshotCapture(
				request,
				options?.execContext,
				items,
				userId,
				directory.id,
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
					totalSteps: GEMINI_STEP_IDS.length,
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
			logger.error(`Gemini CLI pipeline failed: ${err.message}`);
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

	getState(): PipelineState<GeminiStepId> | null {
		return this.state;
	}

	// ── Private helpers ────────────────────────────────────────────────

	private async runScreenshotCapture(
		request: GenerationRequest,
		execContext: PipelineExecutionOptions['execContext'],
		items: ItemData[],
		userId: string,
		directoryId: string,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void },
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<string[]> {
		const shouldCapture = Boolean((request.config || {}).capture_screenshots);
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
			facadeOptions: { userId, directoryId },
			signal,
			logger
		});

		if (status === 'failed') {
			this.failStep('capture-screenshots', new Error(errors[0] || 'Screenshot capture failed'), onLogEntry);
		} else {
			this.completeStep('capture-screenshots', captureScreenshotsStepStartedAt, onLogEntry);
		}

		if (errors.length > 0) {
			const facadeOptions = { userId, directoryId };
			const providerName = await screenshotFacade.getActiveProviderName?.(facadeOptions);
			const label = providerName ? `Screenshot capture (${providerName})` : 'Screenshot capture';
			const unique = [...new Set(errors)];
			return [`${label} failed for ${errors.length} item(s): ${unique.join('; ')}`];
		}
		return [];
	}

	private createGeminiStreamHandlers(onLogEntry?: PipelineExecutionOptions['onLogEntry']): {
		onStdoutLine?: (line: string) => void;
		onStderrLine?: (line: string) => void;
	} {
		if (!onLogEntry) {
			return {};
		}

		return {
			onStdoutLine: (line: string) => {
				const logEntry = this.buildGeminiLogFromStdout(line);
				if (!logEntry) {
					return;
				}

				this.emitGeminiLog({ onLogEntry, ...logEntry });
			},
			onStderrLine: (line: string) => {
				this.emitGeminiLog({
					onLogEntry,
					stepId: 'generate-items',
					event: 'message',
					level: 'error',
					message: this.truncateLogMessage(line)
				});
			}
		};
	}

	private buildGeminiLogFromStdout(line: string): Omit<GeminiLogOptions, 'onLogEntry'> | null {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			return null;
		}

		try {
			const event = JSON.parse(trimmedLine) as Record<string, unknown>;
			const type = this.extractString(event.type);

			switch (type) {
				case 'assistant': {
					const text = this.extractContentText((event.message as { content?: unknown } | undefined)?.content);
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
						'Gemini CLI session completed';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: event.is_error === true ? 'warn' : 'info',
						message: event.is_error === true ? `Gemini CLI result: ${detail}` : detail
					};
				}
				case 'error': {
					const detail =
						this.extractString((event.error as { message?: unknown } | undefined)?.message) ||
						this.extractString(event.message) ||
						this.extractString(event.error) ||
						'Gemini CLI reported an error';
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
						(type ? `Gemini CLI event: ${type}` : undefined);
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

	private extractContentText(content: unknown): string | undefined {
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

	private startStep(stepId: GeminiStepId, onLogEntry?: PipelineExecutionOptions['onLogEntry']): number {
		this.setState(stepId, 'running');
		this.emitGeminiLog({
			onLogEntry,
			stepId,
			event: 'step_started',
			level: 'info',
			message: this.getStepName(stepId)
		});
		return Date.now();
	}

	private completeStep(
		stepId: GeminiStepId,
		startedAt: number,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'completed');
		this.emitGeminiLog({
			onLogEntry,
			stepId,
			event: 'step_completed',
			level: 'info',
			message: this.getStepName(stepId),
			durationMs: Date.now() - startedAt
		});
	}

	private failStep(stepId: GeminiStepId, error: Error, onLogEntry?: PipelineExecutionOptions['onLogEntry']): void {
		this.setState(stepId, 'failed', error.message);
		this.emitGeminiLog({
			onLogEntry,
			stepId,
			event: 'step_failed',
			level: 'error',
			message: `${this.getStepName(stepId)}: ${this.truncateLogMessage(error.message)}`
		});
	}

	private skipStep(stepId: GeminiStepId, message: string, onLogEntry?: PipelineExecutionOptions['onLogEntry']): void {
		this.setState(stepId, 'skipped' as StepStatus);
		this.emitGeminiLog({
			onLogEntry,
			stepId,
			event: 'step_skipped',
			level: 'info',
			message: this.truncateLogMessage(message)
		});
	}

	private emitGeminiLog({ onLogEntry, stepId, message, ...log }: GeminiLogOptions): void {
		if (!onLogEntry) {
			return;
		}

		const stepContext = stepId ? STEP_CONTEXT_BY_ID.get(stepId) : undefined;

		onLogEntry({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			message: this.truncateLogMessage(message),
			stepIndex: stepContext?.stepIndex ?? null,
			stepName: stepContext?.stepName ?? null,
			...log
		});
	}

	private getStepName(stepId: GeminiStepId): string {
		return STEP_CONTEXT_BY_ID.get(stepId)?.stepName ?? stepId;
	}

	private getRunningStepId(): GeminiStepId | undefined {
		if (!this.state) {
			return undefined;
		}

		for (const stepId of GEMINI_STEP_IDS) {
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

	private setState(stepId: GeminiStepId, status: StepStatus, error?: string): void {
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

export default GeminiPlugin;
