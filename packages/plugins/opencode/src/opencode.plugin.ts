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

import type { OpenCodeStepId } from './types.js';
import { OPENCODE_STEP_IDS, DEFAULT_CLI_VERSION } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import { ensureBinary } from './utils/binary-manager.js';
import {
	createWorkspace,
	seedExistingItems,
	seedMetadata,
	readGeneratedItems,
	collectMetadataFromItems,
	cleanupWorkspace
} from './utils/workspace-manager.js';
import { executeOpenCode, type ExecuteResult } from './utils/process-runner.js';
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
	resolveProviderKey,
	buildMetrics,
	buildErrorResult,
	buildCancelledResult
} from './utils/pipeline-helpers.js';
import {
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate,
	getDefaultValues as formDefaults,
	DEFAULT_TARGET_ITEMS
} from './form-schema.js';

function model(id: string, name: string, vision: boolean, context: number): AiModel {
	return {
		id,
		name,
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: vision,
			maxContextLength: context
		}
	};
}

const OPENCODE_SUPPORTED_MODELS: readonly AiModel[] = [
	// ── Anthropic ──
	model('anthropic/claude-sonnet-4-20250514', 'Claude Sonnet 4', true, 200000),
	model('anthropic/claude-haiku-4-5-20251001', 'Claude Haiku 4.5', true, 200000),
	// ── OpenAI ──
	model('openai/gpt-4.1', 'GPT-4.1', true, 1047576),
	model('openai/gpt-4.1-mini', 'GPT-4.1 Mini', true, 1047576),
	model('openai/o3', 'o3', true, 200000),
	model('openai/o4-mini', 'o4-mini', true, 200000),
	// ── Google ──
	model('google/gemini-2.5-pro', 'Gemini 2.5 Pro', true, 1048576),
	model('google/gemini-2.5-flash', 'Gemini 2.5 Flash', true, 1048576),
	// ── Groq ──
	model('groq/llama-3.3-70b-versatile', 'Llama 3.3 70B (Groq)', false, 128000),
	// ── OpenCode Go ──
	model('go/kimi-k2.5', 'OpenCode Go Kimi K2.5', false, 200000),
	model('go/glm-5.1', 'OpenCode Go GLM-5.1', false, 200000),
	model('go/glm-5', 'OpenCode Go GLM-5', false, 200000),
	model('go/mimo-v2-pro', 'OpenCode Go MiMo-V2-Pro', false, 200000),
	model('go/minimax-m2.7', 'OpenCode Go MiniMax M2.7', false, 200000),
	model('go/qwen3.5-plus', 'OpenCode Go Qwen3.5 Plus', false, 200000)
] as const;

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-20250514';

const LOG_MESSAGE_MAX_LENGTH = 500;
const STEP_CONTEXT_BY_ID = new Map(
	STEP_DEFINITIONS.map((step, stepIndex) => [step.id, { stepIndex, stepName: step.name }])
);
type OpenCodeGenerationLog = Parameters<NonNullable<PipelineExecutionOptions['onLogEntry']>>[0];

interface OpenCodeLogOptions {
	readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
	readonly event: OpenCodeGenerationLog['event'];
	readonly level: OpenCodeGenerationLog['level'];
	readonly message: string;
	readonly stepId?: OpenCodeStepId;
	readonly durationMs?: number;
}

/**
 * OpenCode Generator Plugin
 *
 * Full pipeline plugin that delegates the entire generation to OpenCode.
 * Runs a single OpenCode session that handles web search,
 * content creation, and file generation autonomously.
 */
export class OpenCodePlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'opencode';
	readonly name = 'OpenCode Generator';
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
					"Use `machine-local` to rely on this machine's existing OpenCode login, or `api-key` to store an isolated API key for the plugin.",
				default: 'machine-local',
				enum: ['machine-local', 'api-key'],
				'x-scope': 'user'
			},
			provider: {
				type: 'string',
				title: 'Provider',
				description: 'OpenCode provider to authenticate against (e.g. anthropic, openai, google, go, zen, groq, xai).',
				default: DEFAULT_PROVIDER,
				'x-scope': 'user'
			},
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'API key for the selected provider (e.g. Anthropic, OpenAI, Google, or OpenCode Go/Zen key).',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_OPENCODE_API_KEY'
			},
			version: {
				type: 'string',
				title: 'CLI Version',
				description: 'OpenCode CLI version to use',
				default: DEFAULT_CLI_VERSION,
				'x-hidden': true
			},
			model: {
				type: 'string',
				title: 'Model',
				'x-scope': 'global',
				default: DEFAULT_MODEL,
				description: 'Model in provider/model format (e.g. anthropic/claude-sonnet-4-20250514, openai/gpt-4.1, go/kimi-k2.5).'
			}
		},
		required: ['authMode']
	};

	private context: PluginContext | null = null;
	private state: PipelineState<OpenCodeStepId> | null = null;
	private abortController: AbortController | null = null;
	private killProcess: (() => void) | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('OpenCode Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'OpenCode Generator plugin is ready',
			checkedAt: Date.now()
		};
	}

	async listModels(): Promise<readonly AiModel[]> {
		return OPENCODE_SUPPORTED_MODELS;
	}

	private getRealSecret(value: unknown): string | undefined {
		if (typeof value !== 'string' || !value || value.includes('••••')) return undefined;
		return value;
	}

	private resolveAuthMode(settings: Record<string, unknown>): 'machine-local' | 'api-key' {
		return settings.authMode === 'api-key' ? 'api-key' : 'machine-local';
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		const resolved = settings || {};
		if (this.resolveAuthMode(resolved) === 'machine-local') {
			const result = await this.validateMachineLocalCliAuth(resolved);
			return result.valid;
		}

		const apiKey = this.getRealSecret(resolved.apiKey);
		if (!apiKey) {
			return false;
		}

		return this.validateConnectionWithCli(resolved, apiKey);
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		if (this.resolveAuthMode(settings) === 'machine-local') {
			const result = await this.validateMachineLocalCliAuth(settings);
			return result.valid
				? { success: true, message: `Machine-local OpenCode auth verified from ${result.authPath}.` }
				: {
						success: false,
						message:
							result.detail ||
							'Machine-local OpenCode auth is not available. Run `opencode auth login` on this machine first.'
					};
		}

		const apiKey = this.getRealSecret(settings.apiKey);

		if (!apiKey) {
			return {
				success: false,
				message:
					'No API key configured. Add an OpenCode provider API key or switch to machine-local authentication.'
			};
		}

		const valid = await this.validateConnectionWithCli(settings, apiKey);
		return valid
			? { success: true, message: 'OpenCode CLI connection verified.' }
			: { success: false, message: 'OpenCode CLI validation failed. Check the API key, provider, and model.' };
	}

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		if (
			settings.authMode !== undefined &&
			settings.authMode !== 'machine-local' &&
			settings.authMode !== 'api-key'
		) {
			return {
				valid: false,
				errors: [{ path: 'authMode', message: 'Authentication mode must be "machine-local" or "api-key"' }]
			};
		}
		if (settings.apiKey !== undefined && typeof settings.apiKey !== 'string') {
			return {
				valid: false,
				errors: [{ path: 'apiKey', message: 'API key must be a string when provided' }]
			};
		}
		if (settings.provider !== undefined && (typeof settings.provider !== 'string' || !settings.provider.trim())) {
			return {
				valid: false,
				errors: [{ path: 'provider', message: 'Provider must be a non-empty string (e.g. anthropic, openai, google, go, zen).' }]
			};
		}
		if (settings.model !== undefined && (typeof settings.model !== 'string' || !settings.model.trim())) {
			return {
				valid: false,
				errors: [{ path: 'model', message: 'Model must be a non-empty string in provider/model form (e.g. anthropic/claude-sonnet-4-20250514).' }]
			};
		}
		return { valid: true };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Full pipeline plugin that delegates the entire generation to OpenCode',
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
				completionFields: ['authMode', 'provider', 'apiKey', 'model'],
				onboardingDescription: 'Connect your AI assistant to power content generation across your directories.'
			},
			readme: [
				'# OpenCode Generator Plugin',
				'',
				'Full pipeline plugin that delegates the entire directory generation to OpenCode. This plugin runs a single OpenCode session that autonomously handles web search, content creation, and file generation.',
				'',
				'## How it works',
				'',
				'The plugin runs 6 sequential steps:',
				'',
				'1. **Setup OpenCode** - Downloads and caches the OpenCode CLI binary',
				'2. **Prepare Context** - Creates a temporary workspace and seeds it with existing items and metadata',
				'3. **Generate Items** - Executes OpenCode CLI to research and generate directory items as JSON files',
				'4. **Collect Results** - Reads the generated JSON files back to build the pipeline result',
				'5. **Capture Screenshots** - Takes screenshots for items that need images',
				'6. **Cleanup** - Removes the temporary workspace',
				'',
				'## Settings',
				'',
				'| Setting    | Description                                                                     |',
				'| ---------- | ------------------------------------------------------------------------------- |',
				'| `authMode` | `machine-local` or `api-key` authentication                                     |',
				'| `provider` | OpenCode provider key (e.g. `anthropic`, `openai`, `google`, `groq`, `go`, `zen`) |',
				'| `apiKey`   | API key for the selected provider                                               |',
				'| `model`    | Model in `provider/model` form (e.g. `anthropic/claude-sonnet-4-20250514`)      |',
				'',
				'### Providers',
				'',
				'OpenCode is provider-agnostic and supports many upstream providers. Typical choices:',
				'',
				'- `anthropic` — Claude Sonnet / Haiku',
				'- `openai` — GPT-4.1, o3, o4-mini',
				'- `google` — Gemini 2.5 Pro / Flash',
				'- `groq` — Llama and other Groq-hosted models',
				'- `go` / `zen` — OpenCode’s own hosted providers',
				'',
				'Any provider string OpenCode CLI recognises is accepted; the plugin writes an auth entry keyed by `provider` and lets the CLI select the model.',
				'',
				'### Authentication',
				'',
				'**Machine-local auth**:',
				'Run `opencode auth login` on the machine running Ever Works.',
				'OpenCode stores provider credentials in `~/.local/share/opencode/auth.json`.',
				'',
				'**API key auth**:',
				'The plugin writes an isolated auth file for the configured user and runs the CLI against it. Provide an API key for the provider you selected (Anthropic, OpenAI, Google, Groq, OpenCode Go/Zen, etc.).',
				'',
				'## Usage',
				'',
				"Enable the plugin for a directory and trigger generation with `providers.pipeline: 'opencode'`."
			].join('\n'),
			homepage: 'https://opencode.ai/docs/cli/',
			icon: {
				type: 'svg',
				value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><title>OpenCode</title><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zm3.4 2.9L5.8 10l1.6 1.6L5.8 13.2l1.6 1.6 3.2-3.2zm4.2 6.2h2.1l2.7-5.2h-2.1z" fill="#111827"/></svg>`
			}
		};
	}

	private async validateConnectionWithCli(settings: Record<string, unknown>, apiKey: string): Promise<boolean> {
		const version = (settings.version as string) || DEFAULT_CLI_VERSION;
		const provider = resolveProviderKey(settings);
		const model = (settings.model as string | undefined) || DEFAULT_MODEL;
		let tempDir: string | null = null;
		let killProcess: (() => void) | null = null;

		try {
			const binaryPath = await ensureBinary(version, this.context?.logger || console);
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ever-works-opencode-validate-'));
			await this.prepareOpenCodeConfig(tempDir, provider, apiKey, model);

			const execution = executeOpenCode({
				binaryPath,
				prompt: 'Reply with exactly OK. Do not ask follow-up questions and do not modify any files.',
				cwd: tempDir,
				env: this.buildOpenCodeEnv(tempDir, model),
				model
			});
			killProcess = execution.kill;

			const result = await Promise.race([
				execution.promise,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Validation timed out')), 30_000))
			]);

			return result.exitCode === 0;
		} catch (err) {
			this.context?.logger.warn(
				`OpenCode CLI validation failed: ${err instanceof Error ? err.message : 'unknown error'}`
			);
			return false;
		} finally {
			killProcess?.();
			if (tempDir) {
				await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
			}
		}
	}

	private getMachineAuthPath(): string {
		const xdgDataHome = process.env.XDG_DATA_HOME;
		if (xdgDataHome) {
			return path.join(xdgDataHome, 'opencode', 'auth.json');
		}

		return path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
	}

	private async hasMachineAuthForProvider(provider: string): Promise<boolean> {
		try {
			const content = await fs.readFile(this.getMachineAuthPath(), 'utf-8');
			const parsed = JSON.parse(content) as Record<string, unknown>;
			const providerEntry = parsed[provider];
			return typeof providerEntry === 'object' && providerEntry !== null;
		} catch {
			return false;
		}
	}

	private async validateMachineLocalCliAuth(
		settings: Record<string, unknown>
	): Promise<{ valid: boolean; detail?: string; authPath: string }> {
		const version = (settings.version as string) || DEFAULT_CLI_VERSION;
		const provider = resolveProviderKey(settings);
		const model = (settings.model as string | undefined) || DEFAULT_MODEL;
		const authPath = this.getMachineAuthPath();
		let tempDir: string | null = null;

		if (!(await this.hasMachineAuthForProvider(provider))) {
			return {
				valid: false,
				authPath,
				detail: `Machine-local OpenCode auth for provider "${provider}" was not found at ${authPath}. Run \`opencode auth login\` first.`
			};
		}

		let killValidation: (() => void) | null = null;

		try {
			const binaryPath = await ensureBinary(version, this.context?.logger || console);
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ever-works-opencode-machine-validate-'));

			const execution = executeOpenCode({
				binaryPath,
				prompt: 'Reply with exactly OK. Do not ask follow-up questions and do not modify any files.',
				cwd: tempDir,
				env: this.buildMachineLocalEnv(model),
				model
			});
			killValidation = execution.kill;

			const result = await Promise.race([
				execution.promise,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Validation timed out')), 30_000))
			]);

			return result.exitCode === 0
				? { valid: true, authPath }
				: { valid: false, authPath, detail: this.extractErrorDetail(result) };
		} catch (err) {
			return {
				valid: false,
				authPath,
				detail: err instanceof Error ? err.message : 'Machine-local OpenCode validation failed.'
			};
		} finally {
			killValidation?.();
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
		this.abortController = new AbortController();
		const signal = options?.signal ?? this.abortController.signal;
		const onLogEntry = options?.onLogEntry;

		this.state = initializeState();

		const logger = this.context?.logger ?? console;
		const userId = directory.user?.id;

		if (!userId) {
			return this.handleError(new Error('User ID is required'), startTime);
		}

		try {
			const settings = await resolveSettings(this.context, userId, directory.id);
			if (settings.model) {
				logger.log(`Using model "${settings.model}" for this session as specified in settings`);
			}

			const version = (settings.version as string) || DEFAULT_CLI_VERSION;
			const model = (settings.model as string | undefined) || DEFAULT_MODEL;
			const provider = resolveProviderKey(settings);
			const apiKey = this.getRealSecret(settings.apiKey);
			const authMode = this.resolveAuthMode(settings);

			if (authMode === 'api-key' && !apiKey) {
				return this.handleError(
					new Error('OpenCode API key is required when API key authentication is selected'),
					startTime
				);
			}

			if (authMode === 'machine-local') {
				const machineAuth = await this.validateMachineLocalCliAuth(settings);
				if (!machineAuth.valid) {
					return this.handleError(
						new Error(machineAuth.detail || 'Machine-local OpenCode auth is not available'),
						startTime
					);
				}
			}

			// ── Step 1: Setup OpenCode ──────────────────────────────
			const setupStepStartedAt = this.startStep('setup-opencode', onLogEntry);
			reportProgress(onProgress, 0, 0, 'Setup OpenCode');

			const binaryPath = await ensureBinary(version, logger);
			this.completeStep('setup-opencode', setupStepStartedAt, onLogEntry);

			if (signal.aborted) return this.handleCancel(startTime);

			// ── Step 2: Prepare Context ────────────────────────────────
			const prepareContextStepStartedAt = this.startStep('prepare-context', onLogEntry);
			reportProgress(onProgress, 1, 20, 'Prepare Context');

			const workspacePath = await createWorkspace(userId, directory.id);
			if (authMode === 'api-key' && apiKey) {
				await this.prepareOpenCodeConfig(workspacePath, provider, apiKey, model);
			}
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				directory: { name: directory.name, description: directory.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands
			});
			this.completeStep('prepare-context', prepareContextStepStartedAt, onLogEntry);

			if (signal.aborted) return this.handleCancel(startTime);

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
				const { onStdoutLine, onStderrLine } = this.createOpenCodeStreamHandlers(onLogEntry);

				const { promise, kill } = executeOpenCode({
					binaryPath,
					prompt: this.buildCombinedPrompt(systemPrompt, userPrompt),
					cwd: workspacePath,
					env:
						authMode === 'api-key'
							? this.buildOpenCodeEnv(workspacePath, model)
							: this.buildMachineLocalEnv(model),
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

				logger.warn(`OpenCode exited with code ${execResult.exitCode}: ${detail}`);
				generationWarning = `OpenCode finished with an error (${detail}).`;
				this.emitOpenCodeLog({
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
				const stderrExcerpt = execResult.stderr?.trim().split('\n').slice(0, 5).join('\n') || '';
				const stdoutExcerpt = execResult.stdout?.trim().split('\n').slice(-5).join('\n') || '';
				const detail = stderrExcerpt || stdoutExcerpt || `exit code ${execResult.exitCode}`;
				throw new Error(`OpenCode completed but produced no valid item files. CLI output:\n${detail}`);
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

			await cleanupWorkspace(userId, directory.id);
			this.completeStep('cleanup', cleanupStepStartedAt, onLogEntry);

			// ── Build result ───────────────────────────────────────────
			reportProgress(onProgress, 6, 100, 'Complete');

			const duration = Date.now() - startTime;
			const warnings = [...(generationWarning ? [generationWarning] : []), ...screenshotWarnings];

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
					totalSteps: OPENCODE_STEP_IDS.length,
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
			logger.error(`OpenCode pipeline failed: ${err.message}`);
			await cleanupWorkspace(userId, directory.id);
			return this.handleError(err, startTime);
		}
	}

	async cancel(): Promise<void> {
		this.abortController?.abort();
		this.killProcess?.();
		this.killProcess = null;
	}

	getState(): PipelineState<OpenCodeStepId> | null {
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

	private createOpenCodeStreamHandlers(onLogEntry?: PipelineExecutionOptions['onLogEntry']): {
		onStdoutLine?: (line: string) => void;
		onStderrLine?: (line: string) => void;
	} {
		if (!onLogEntry) {
			return {};
		}

		return {
			onStdoutLine: (line: string) => {
				const logEntry = this.buildOpenCodeLogFromStdout(line);
				if (!logEntry) {
					return;
				}

				this.emitOpenCodeLog({ onLogEntry, ...logEntry });
			},
			onStderrLine: (line: string) => {
				this.emitOpenCodeLog({
					onLogEntry,
					stepId: 'generate-items',
					event: 'message',
					level: 'error',
					message: this.truncateLogMessage(line)
				});
			}
		};
	}

	private async prepareOpenCodeConfig(
		baseDir: string,
		provider: string,
		apiKey: string,
		model: string
	): Promise<void> {
		const dataDir = path.join(baseDir, '.opencode-data', 'opencode');
		const configDir = path.join(baseDir, '.opencode-config');

		await fs.mkdir(dataDir, { recursive: true });
		await fs.mkdir(configDir, { recursive: true });

		await fs.writeFile(
			path.join(dataDir, 'auth.json'),
			JSON.stringify(
				{
					[provider]: {
						type: 'api',
						key: apiKey
					}
				},
				null,
				2
			),
			'utf-8'
		);

		await fs.writeFile(
			path.join(configDir, 'opencode.json'),
			JSON.stringify(
				{
					$schema: 'https://opencode.ai/config.json',
					model,
					small_model: model
				},
				null,
				2
			),
			'utf-8'
		);
	}

	private buildOpenCodeEnv(baseDir: string, model: string): Record<string, string> {
		const dataHome = path.join(baseDir, '.opencode-data');
		const configDir = path.join(baseDir, '.opencode-config');

		return {
			HOME: baseDir,
			XDG_DATA_HOME: dataHome,
			OPENCODE_CONFIG_DIR: configDir,
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				$schema: 'https://opencode.ai/config.json',
				model,
				small_model: model
			}),
			OPENCODE_DISABLE_AUTOUPDATE: '1'
		};
	}

	private buildMachineLocalEnv(model: string): Record<string, string> {
		const env: Record<string, string> = {
			HOME: process.env.HOME ?? os.homedir(),
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				$schema: 'https://opencode.ai/config.json',
				model,
				small_model: model
			}),
			OPENCODE_DISABLE_AUTOUPDATE: '1'
		};

		if (process.env.XDG_DATA_HOME) {
			env.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
		}

		return env;
	}

	private buildCombinedPrompt(systemPrompt: string, userPrompt: string): string {
		return [
			'You must follow the system instructions below exactly.',
			'',
			'<system_instructions>',
			systemPrompt,
			'</system_instructions>',
			'',
			'<user_request>',
			userPrompt,
			'</user_request>'
		].join('\n');
	}

	private buildOpenCodeLogFromStdout(line: string): Omit<OpenCodeLogOptions, 'onLogEntry'> | null {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			return null;
		}

		try {
			const event = JSON.parse(trimmedLine) as Record<string, unknown>;
			const type = this.extractString(event.type);

			switch (type) {
				case 'assistant': {
					const text = this.extractOpenCodeContentText(
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
						'OpenCode session completed';
					return {
						stepId: 'generate-items',
						event: 'message',
						level: event.is_error === true ? 'warn' : 'info',
						message: event.is_error === true ? `OpenCode result: ${detail}` : detail
					};
				}
				case 'error': {
					const detail =
						this.extractString((event.error as { message?: unknown } | undefined)?.message) ||
						this.extractString(event.message) ||
						this.extractString(event.error) ||
						'OpenCode reported an error';
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
						(type ? `OpenCode event: ${type}` : undefined);
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

	private extractOpenCodeContentText(content: unknown): string | undefined {
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

	private startStep(stepId: OpenCodeStepId, onLogEntry?: PipelineExecutionOptions['onLogEntry']): number {
		this.setState(stepId, 'running');
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_started',
			level: 'info',
			message: this.getStepName(stepId)
		});
		return Date.now();
	}

	private completeStep(
		stepId: OpenCodeStepId,
		startedAt: number,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'completed');
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_completed',
			level: 'info',
			message: this.getStepName(stepId),
			durationMs: Date.now() - startedAt
		});
	}

	private failStep(stepId: OpenCodeStepId, error: Error, onLogEntry?: PipelineExecutionOptions['onLogEntry']): void {
		this.setState(stepId, 'failed', error.message);
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_failed',
			level: 'error',
			message: `${this.getStepName(stepId)}: ${this.truncateLogMessage(error.message)}`
		});
	}

	private skipStep(
		stepId: OpenCodeStepId,
		message: string,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'skipped' as StepStatus);
		this.emitOpenCodeLog({
			onLogEntry,
			stepId,
			event: 'step_skipped',
			level: 'info',
			message: this.truncateLogMessage(message)
		});
	}

	private emitOpenCodeLog({ onLogEntry, stepId, message, ...log }: OpenCodeLogOptions): void {
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

	private getStepName(stepId: OpenCodeStepId): string {
		return STEP_CONTEXT_BY_ID.get(stepId)?.stepName ?? stepId;
	}

	private getRunningStepId(): OpenCodeStepId | undefined {
		if (!this.state) {
			return undefined;
		}

		for (const stepId of OPENCODE_STEP_IDS) {
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

	private setState(stepId: OpenCodeStepId, status: StepStatus, error?: string): void {
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

export default OpenCodePlugin;
