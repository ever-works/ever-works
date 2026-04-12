import type {
	AiModel,
	ConnectionValidationResult,
	FacadeOptions,
	DirectoryReference,
	ExistingItems,
	FormFieldDefinition,
	FormFieldGroup,
	GenerationRequest,
	IFormSchemaProvider,
	IPlugin,
	IPipelinePlugin,
	JsonSchema,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	PipelineStepDefinition,
	PipelineState,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	StepStatus,
	ValidationResult
} from '@ever-works/plugin';
import { buildSuccessPipelineResult, lucideIcon, normalizeItemTags, type ItemData } from '@ever-works/plugin';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';

import type { CodexStepId } from './types.js';
import { DEFAULT_MODEL } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	DEFAULT_TARGET_ITEMS,
	getDefaultValues as formDefaults,
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate
} from './form-schema.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt/system-prompt.js';
import { executeCodex, type ExecuteResult } from './utils/process-runner.js';
import {
	cleanupWorkspace,
	collectMetadataFromItems,
	createWorkspace,
	describeWorkspaceOutputs,
	readGeneratedItems,
	seedExistingItems,
	seedMetadata,
	writeGeneratedItems
} from './utils/workspace-manager.js';
import { captureScreenshots } from './utils/screenshot-capture.js';
import {
	buildCancelledResult,
	buildErrorResult,
	buildMetrics,
	hasLocalCodexAuth,
	initializeState,
	reportProgress,
	resolveExecutionAuth,
	resolveSettings,
	updateStepState
} from './utils/pipeline-helpers.js';

const CODEX_SUPPORTED_MODELS: readonly AiModel[] = [
	{
		id: 'gpt-5.4',
		name: 'GPT-5.4',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 400000
		}
	},
	{
		id: 'codex-mini-latest',
		name: 'Codex Mini Latest',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 200000
		}
	},
	{
		id: 'gpt-5.2-codex',
		name: 'GPT-5.2 Codex',
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 400000
		}
	}
] as const;

const MANIFEST: PluginManifest = {
	id: 'codex',
	name: 'Codex Generator',
	version: '1.0.0',
	category: 'pipeline',
	capabilities: ['pipeline', 'form-schema-provider'],
	description: 'Full pipeline plugin that delegates the entire generation to Codex',
	author: { name: 'Ever Works Team' },
	license: 'MIT',
	builtIn: true,
	autoEnable: false,
	visibility: 'public',
	selectableProviderCategories: ['screenshot'],
	icon: lucideIcon('sparkles'),
	uiHints: {
		byok: {
			buttonLabel: 'Bring your own key',
			triggerField: 'apiKey'
		},
		onboardingWizard: true,
		includeInOnboarding: true,
		onboardingPriority: 2,
		completionFields: ['apiKey'],
		onboardingDescription:
			'Connect Codex with an OpenAI API key or local Codex CLI auth for end-to-end directory generation.',
		setupLink: {
			url: 'https://platform.openai.com/account/api-keys',
			label: 'OpenAI API keys',
			buttonLabel: 'Get API key',
			showWhenEmpty: ['apiKey']
		}
	},
	readme: [
		'# Codex Generator Plugin',
		'',
		'Full pipeline plugin that delegates the entire directory generation to Codex. This plugin runs a single Codex session that researches, creates, and updates directory item JSON files inside a temporary workspace.',
		'',
		'## How it works',
		'',
		'The plugin runs 6 sequential steps:',
		'',
		'1. **Setup Codex** - Resolves authentication and prepares the Codex CLI runtime',
		'2. **Prepare Context** - Creates a temporary workspace and seeds it with existing items and metadata',
		'3. **Generate Items** - Executes Codex CLI to research and generate directory items as JSON files',
		'4. **Collect Results** - Reads the generated JSON files back to build the pipeline result',
		'5. **Capture Screenshots** - Takes screenshots for items that need images',
		'6. **Cleanup** - Removes the temporary workspace',
		'',
		'## Settings',
		'',
		'| Setting                 | Description                                                                 |',
		'| ----------------------- | --------------------------------------------------------------------------- |',
		'| `apiKey`                | OpenAI API key used for Codex execution                                     |',
		'| `model`                 | Codex model to use for generation                                           |',
		'| `unsafeBypassSandbox`   | Hidden opt-in flag to bypass Codex sandboxing on incompatible host systems  |',
		'',
		'### Authentication',
		'',
		'Codex supports two authentication modes:',
		'',
		'1. **API Key** - Provide `apiKey` in plugin settings.',
		'2. **Local Codex Auth** - If no `apiKey` is configured, the plugin can reuse local Codex CLI auth from `CODEX_HOME` or `~/.codex/auth.json`.',
		'',
		'**API Key**:',
		'',
		'Get one from [platform.openai.com/account/api-keys](https://platform.openai.com/account/api-keys)',
		'',
		'**Local Codex Auth**:',
		'',
		'```bash',
		'codex login',
		'```',
		'',
		'This signs the local Codex CLI into your OpenAI account and stores reusable local auth for subsequent runs.',
		'',
		'### Sandbox Compatibility',
		'',
		'Codex normally runs with its own sandboxed execution path. Some host environments may block Codex sandboxing. In those cases, the hidden `unsafeBypassSandbox` setting can opt into `--dangerously-bypass-approvals-and-sandbox`.',
		'',
		'Use that mode only in environments that are already externally sandboxed or otherwise trusted.',
		'',
		'## Usage',
		'',
		"Enable the plugin for a directory and trigger generation with `providers.pipeline: 'codex'`.",
		'',
		'## Manual Smoke Test',
		'',
		'You can validate the real Codex CLI integration locally with:',
		'',
		'```bash',
		'pnpm --filter @ever-works/codex-plugin smoke',
		'```',
		'',
		'If your host requires the dangerous bypass mode, run:',
		'',
		'```bash',
		'CODEX_SMOKE_BYPASS_SANDBOX=1 pnpm --filter @ever-works/codex-plugin smoke',
		'```'
	].join('\n'),
	homepage: 'https://github.com/openai/codex'
};

function hasLocalCodexAuthSync(): boolean {
	const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
	return fs.existsSync(path.join(codexHome, 'auth.json'));
}

const LOG_MESSAGE_MAX_LENGTH = 500;
const RECOVERY_ITEMS_SCHEMA_FILE = 'recovered-items.schema.json';
const RECOVERY_ITEMS_OUTPUT_FILE = 'recovered-items.json';
const STEP_CONTEXT_BY_ID = new Map(
	STEP_DEFINITIONS.map((step, stepIndex) => [step.id, { stepIndex, stepName: step.name }])
);

const RECOVERY_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['items'],
	properties: {
		items: {
			type: 'array',
			minItems: 1,
			items: {
				type: 'object',
				additionalProperties: true,
				required: ['name', 'description', 'source_url', 'category', 'tags'],
				properties: {
					name: { type: 'string' },
					description: { type: 'string' },
					source_url: { type: 'string' },
					category: { type: 'string' },
					tags: {
						type: 'array',
						items: { type: 'string' }
					},
					brand: { type: 'string' },
					markdown: { type: 'string' },
					image_url: { type: 'string' },
					website_url: { type: 'string' },
					pricing_json: {},
					extra: {}
				}
			}
		}
	}
} as const;

export class CodexPlugin implements IPlugin, IPipelinePlugin, IFormSchemaProvider {
	readonly id = 'codex';
	readonly name = 'Codex Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'OpenAI API key for Codex CLI execution',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'OPENAI_API_KEY'
			},
			model: {
				type: 'string',
				title: 'Model',
				'x-scope': 'global',
				'x-widget': 'model-select',
				default: DEFAULT_MODEL,
				description: 'Model to use for Codex generation'
			},
			unsafeBypassSandbox: {
				type: 'boolean',
				title: 'Unsafe Sandbox Bypass',
				description:
					'Allow Codex to run with --dangerously-bypass-approvals-and-sandbox for hosts where Codex sandboxing is incompatible.',
				default: false,
				'x-hidden': true
			}
		}
	};

	private context: PluginContext | null = null;
	private state: PipelineState<CodexStepId> | null = null;
	private abortController: AbortController | null = null;
	private killProcess: (() => void) | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.state = initializeState();
		context.logger.log('Codex Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.state = null;
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Codex Generator plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		if (hasLocalCodexAuthSync()) {
			return {
				...MANIFEST,
				uiHints: {
					...MANIFEST.uiHints,
					completionFields: undefined
				}
			};
		}

		return MANIFEST;
	}

	async listModels(): Promise<readonly AiModel[]> {
		return CODEX_SUPPORTED_MODELS;
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		const resolved = settings || {};
		const apiKey = typeof resolved.apiKey === 'string' ? resolved.apiKey.trim() : '';
		const model = typeof resolved.model === 'string' ? resolved.model : DEFAULT_MODEL;

		if (apiKey) {
			return this.validateApiKey(apiKey, model);
		}

		return this.validateCliAuth(resolved);
	}

	getStepDefinitions(): readonly PipelineStepDefinition<CodexStepId>[] {
		return STEP_DEFINITIONS;
	}

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

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		if (settings.apiKey !== undefined && typeof settings.apiKey !== 'string') {
			return {
				valid: false,
				errors: [{ path: 'apiKey', message: 'API key must be a string when provided' }]
			};
		}
		if (settings.unsafeBypassSandbox !== undefined && typeof settings.unsafeBypassSandbox !== 'boolean') {
			return {
				valid: false,
				errors: [
					{
						path: 'unsafeBypassSandbox',
						message: 'Unsafe sandbox bypass must be a boolean when provided'
					}
				]
			};
		}

		return { valid: true };
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
		const model = typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL;
		if (apiKey) {
			const valid = await this.validateApiKey(apiKey, model);
			return valid
				? { success: true, message: 'OpenAI API key verified for Codex.' }
				: {
						success: false,
						message:
							'OpenAI API key validation failed. Verify the key, model access, and billing, or use local `codex login`.'
					};
		}

		if (await hasLocalCodexAuth(settings)) {
			const valid = await this.validateCliAuth(settings);
			return valid
				? { success: true, message: 'Local Codex CLI auth verified.' }
				: {
						success: false,
						message:
							'Local Codex CLI auth could not be verified. Re-run `codex login` or provide an OpenAI API key.'
					};
		}

		return {
			success: false,
			message: 'Configure an OpenAI API key or sign in locally with Codex CLI first'
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
		this.state = initializeState();
		this.abortController = new AbortController();

		if (options?.signal) {
			if (options.signal.aborted) {
				this.abortController.abort();
			} else {
				options.signal.addEventListener('abort', () => this.abortController?.abort(), { once: true });
			}
		}

		const signal = this.abortController.signal;
		const onLogEntry = options?.onLogEntry;
		const logger = this.context?.logger ?? console;
		const userId = directory.user?.id ?? 'system';

		let workspaceCreated = false;

		try {
			const setupStartedAt = this.startStep('setup-codex', onLogEntry);
			reportProgress(onProgress, 0, 5, 'Setup Codex');

			const settings = await resolveSettings(this.context, userId, directory.id);
			const executionAuth = await resolveExecutionAuth(settings);
			if (!executionAuth) {
				throw new Error(
					'No Codex authentication available. Configure an OpenAI API key or sign in locally with Codex CLI.'
				);
			}

			this.emitCodexLog({
				onLogEntry,
				stepId: 'setup-codex',
				event: 'message',
				level: 'info',
				message: `Using Codex ${executionAuth.mode === 'api-key' ? 'API key' : 'local auth'} mode`
			});
			this.completeStep('setup-codex', setupStartedAt, onLogEntry);

			const prepareStartedAt = this.startStep('prepare-context', onLogEntry);
			reportProgress(onProgress, 1, 15, 'Prepare Context');

			const workspacePath = await createWorkspace(userId, directory.id);
			workspaceCreated = true;
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				directory: { name: directory.name, description: directory.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands
			});
			this.completeStep('prepare-context', prepareStartedAt, onLogEntry);

			const generateStartedAt = this.startStep('generate-items', onLogEntry);
			reportProgress(onProgress, 2, 30, 'Generate Items');

			const prompt = this.buildExecutionPrompt(directory, request, existing, workspacePath);
			let executionResult = await this.runCodexPrompt({
				workspacePath,
				executionAuthEnv: executionAuth.env,
				model: typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL,
				bypassApprovalsAndSandbox: settings.unsafeBypassSandbox === true,
				prompt,
				signal,
				onLogEntry,
				stepId: 'generate-items'
			});

			if (signal.aborted || executionResult.killed) {
				return this.handleCancel(startTime);
			}

			if (executionResult.exitCode !== 0) {
				throw new Error(this.extractErrorDetail(executionResult));
			}

			reportProgress(onProgress, 2, 80, 'Generate Items', 'Codex execution finished');
			this.completeStep('generate-items', generateStartedAt, onLogEntry);

			const collectStartedAt = this.startStep('collect-results', onLogEntry);
			reportProgress(onProgress, 3, 85, 'Collect Results');

			let items = await readGeneratedItems(workspacePath, logger);
			const requestedTargetItems = Number(request.config?.target_items ?? DEFAULT_TARGET_ITEMS);
			if (items.length === 0 && (requestedTargetItems > 0 || existing.items.length === 0)) {
				const shouldRetryWithBypass =
					settings.unsafeBypassSandbox !== true && this.detectSandboxWriteBlock(executionResult);

				if (shouldRetryWithBypass) {
					this.emitCodexLog({
						onLogEntry,
						stepId: 'generate-items',
						event: 'message',
						level: 'warn',
						message: 'Codex reported sandboxed file-write blockage; retrying once with sandbox bypass'
					});

					executionResult = await this.runCodexPrompt({
						workspacePath,
						executionAuthEnv: executionAuth.env,
						model: typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL,
						bypassApprovalsAndSandbox: true,
						prompt,
						signal,
						onLogEntry,
						stepId: 'generate-items',
						logPrefix: '[retry:bypass] '
					});

					if (signal.aborted || executionResult.killed) {
						return this.handleCancel(startTime);
					}

					if (executionResult.exitCode !== 0) {
						throw new Error(this.extractErrorDetail(executionResult));
					}

					items = await readGeneratedItems(workspacePath, logger);
				}

				const recoveredItems = await this.recoverItemsFromStructuredOutput({
					directory,
					request,
					existing,
					workspacePath,
					settings,
					executionAuthEnv: executionAuth.env,
					preferBypass: shouldRetryWithBypass,
					onLogEntry,
					signal
				});

				if (recoveredItems.length > 0) {
					await writeGeneratedItems(workspacePath, recoveredItems);
					items = await readGeneratedItems(workspacePath, logger);
				}

				if (items.length === 0) {
					const workspaceOutputs = await describeWorkspaceOutputs(workspacePath);
					const outputSummary =
						workspaceOutputs.length > 0 ? workspaceOutputs.join(', ') : 'no visible files created';
					const stderrExcerpt = executionResult.stderr?.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
					const stdoutExcerpt = executionResult.stdout?.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
					const cliSummaryParts = [
						stderrExcerpt ? `stderr: ${stderrExcerpt}` : '',
						stdoutExcerpt ? `stdout: ${stdoutExcerpt}` : ''
					].filter(Boolean);
					const cliSummary =
						cliSummaryParts.length > 0 ? ` Codex output excerpt: ${cliSummaryParts.join(' ; ')}.` : '';
					throw new Error(
						`Codex completed without producing any valid item JSON files in the workspace root. Visible workspace entries: ${outputSummary}.${cliSummary}`
					);
				}
			}
			const metadata = collectMetadataFromItems(items);
			this.completeStep('collect-results', collectStartedAt, onLogEntry);

			const screenshotWarnings = await this.runScreenshotCapture(
				request,
				options?.execContext,
				items as never[],
				userId,
				directory.id,
				signal,
				onProgress,
				logger,
				onLogEntry
			);

			const cleanupStartedAt = this.startStep('cleanup', onLogEntry);
			reportProgress(onProgress, 5, 95, 'Cleanup');
			await cleanupWorkspace(userId, directory.id);
			workspaceCreated = false;
			this.completeStep('cleanup', cleanupStartedAt, onLogEntry);

			reportProgress(onProgress, 6, 100, 'Complete');
			const duration = Date.now() - startTime;

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
					stepsCompleted: this.state?.completedSteps.length ?? 0,
					totalSteps: STEP_DEFINITIONS.length,
					state: this.state ?? undefined,
					warnings: screenshotWarnings.length > 0 ? screenshotWarnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const runningStepId = this.getRunningStepId();
			if (runningStepId) {
				this.failStep(runningStepId, err, onLogEntry);
			}
			if (workspaceCreated) {
				await cleanupWorkspace(userId, directory.id);
			}
			return this.handleError(err, startTime);
		}
	}

	async cancel(): Promise<void> {
		this.abortController?.abort();
		this.killProcess?.();
		this.killProcess = null;
	}

	getState(): PipelineState<CodexStepId> | null {
		return this.state;
	}

	private buildExecutionPrompt(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		workspacePath: string
	): string {
		const promptOptions = {
			directory,
			request: {
				...request,
				config: {
					target_items: Number(request.config?.target_items ?? DEFAULT_TARGET_ITEMS),
					...(request.config || {})
				}
			},
			existing,
			workspacePath
		};

		return [buildSystemPrompt(promptOptions), '', buildUserPrompt(promptOptions)].join('\n');
	}

	private async runCodexPrompt({
		workspacePath,
		executionAuthEnv,
		model,
		bypassApprovalsAndSandbox,
		prompt,
		signal,
		onLogEntry,
		stepId,
		logPrefix = ''
	}: {
		readonly workspacePath: string;
		readonly executionAuthEnv: Record<string, string>;
		readonly model: string;
		readonly bypassApprovalsAndSandbox: boolean;
		readonly prompt: string;
		readonly signal: AbortSignal;
		readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
		readonly stepId: CodexStepId;
		readonly logPrefix?: string;
	}): Promise<ExecuteResult> {
		const { promise, kill } = executeCodex({
			command: 'codex',
			cwd: workspacePath,
			env: executionAuthEnv,
			model,
			bypassApprovalsAndSandbox,
			prompt,
			signal,
			onStdoutLine: (line) => {
				this.emitCodexLog({
					onLogEntry,
					stepId,
					event: 'message',
					level: 'info',
					message: `${logPrefix}${line}`
				});
			},
			onStderrLine: (line) => {
				this.emitCodexLog({
					onLogEntry,
					stepId,
					event: 'message',
					level: 'warn',
					message: `${logPrefix}${line}`
				});
			}
		});

		this.killProcess = kill;
		const result = await promise;
		this.killProcess = null;
		return result;
	}

	private async recoverItemsFromStructuredOutput({
		directory,
		request,
		existing,
		workspacePath,
		settings,
		executionAuthEnv,
		preferBypass,
		onLogEntry,
		signal
	}: {
		readonly directory: DirectoryReference;
		readonly request: GenerationRequest;
		readonly existing: ExistingItems;
		readonly workspacePath: string;
		readonly settings: Record<string, unknown>;
		readonly executionAuthEnv: Record<string, string>;
		readonly preferBypass: boolean;
		readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
		readonly signal: AbortSignal;
	}): Promise<ExistingItems['items']> {
		const logger = this.context?.logger ?? console;
		const recoverySchemaPath = path.join(workspacePath, '_meta', RECOVERY_ITEMS_SCHEMA_FILE);
		const recoveryOutputPath = path.join(workspacePath, '_meta', RECOVERY_ITEMS_OUTPUT_FILE);

		await fs.promises.writeFile(recoverySchemaPath, JSON.stringify(RECOVERY_OUTPUT_SCHEMA, null, 2), 'utf-8');

		this.emitCodexLog({
			onLogEntry,
			stepId: 'collect-results',
			event: 'message',
			level: 'warn',
			message: 'Codex produced no item files; attempting structured JSON recovery'
		});

		const recoveryPrompt = this.buildStructuredRecoveryPrompt(directory, request, existing);
		const { promise, kill } = executeCodex({
			command: 'codex',
			cwd: workspacePath,
			env: executionAuthEnv,
			model: typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL,
			bypassApprovalsAndSandbox: settings.unsafeBypassSandbox === true || preferBypass,
			outputSchemaPath: recoverySchemaPath,
			outputLastMessagePath: recoveryOutputPath,
			prompt: recoveryPrompt,
			signal,
			onStdoutLine: (line) => {
				this.emitCodexLog({
					onLogEntry,
					stepId: 'collect-results',
					event: 'message',
					level: 'info',
					message: `[recovery] ${line}`
				});
			},
			onStderrLine: (line) => {
				this.emitCodexLog({
					onLogEntry,
					stepId: 'collect-results',
					event: 'message',
					level: 'warn',
					message: `[recovery] ${line}`
				});
			}
		});

		this.killProcess = kill;
		const recoveryResult = await promise;
		this.killProcess = null;

		if (signal.aborted || recoveryResult.killed || recoveryResult.exitCode !== 0) {
			return [];
		}

		try {
			const payloadText = await fs.promises.readFile(recoveryOutputPath, 'utf-8');
			const payload = JSON.parse(payloadText) as { items?: unknown[] };
			if (!Array.isArray(payload.items) || payload.items.length === 0) {
				return [];
			}

			const recoveredItems = payload.items
				.map((item) => this.normalizeRecoveredItem(item, logger))
				.filter((item): item is ExistingItems['items'][number] => item !== null);

			if (recoveredItems.length > 0) {
				this.emitCodexLog({
					onLogEntry,
					stepId: 'collect-results',
					event: 'message',
					level: 'info',
					message: `Recovered ${recoveredItems.length} items from structured Codex output`
				});
			}

			return recoveredItems;
		} catch (error) {
			logger.warn(
				`Failed to parse structured Codex recovery output: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	private buildStructuredRecoveryPrompt(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems
	): string {
		const targetItems = Number(request.config?.target_items ?? DEFAULT_TARGET_ITEMS);
		const contextParts = [
			'The previous Codex run completed research but failed to persist item files in the workspace.',
			'This recovery run must return the final items directly as structured JSON matching the provided schema.',
			'Do not explain your work. Do not ask for another message. Do not mention sandbox limitations.',
			`Directory: ${directory.name}`,
			directory.description ? `Directory description: ${directory.description}` : '',
			request.prompt ? `Requested topic: ${request.prompt}` : '',
			request.name ? `Requested name: ${request.name}` : '',
			existing.items.length > 0
				? `Existing items already present: ${existing.items.length}. Avoid duplicates and focus on new or improved items only.`
				: 'No existing items are present yet.',
			`Return approximately ${targetItems} high-confidence items.`,
			'Each item must include: name, description, source_url, category, tags.',
			'Use official canonical URLs only. Tags must be an array of strings.'
		]
			.filter(Boolean)
			.join('\n');

		return contextParts;
	}

	private detectSandboxWriteBlock(result: ExecuteResult): boolean {
		const combined = [result.stderr, result.stdout]
			.filter(Boolean)
			.join('\n')
			.toLowerCase();

		return (
			combined.includes('sandbox issue') ||
			combined.includes('sandboxed file-write blockage') ||
			combined.includes('file writes were blocked') ||
			combined.includes('local file writes were blocked') ||
			combined.includes('write the full json files immediately') ||
			combined.includes('insufficient to finish the task because local file writes were blocked')
		);
	}

	private normalizeRecoveredItem(item: unknown, logger: { warn(message: string): void }): ItemData | null {
		if (!item || typeof item !== 'object') {
			return null;
		}

		const normalized = item as Record<string, unknown>;
		if (!this.hasRequiredRecoveredFields(normalized)) {
			return null;
		}

		normalizeItemTags(normalized);
		if (!Array.isArray(normalized.tags)) {
			logger.warn('Recovered Codex item had invalid tags and was skipped');
			return null;
		}

		return normalized as unknown as ItemData;
	}

	private hasRequiredRecoveredFields(item: Record<string, unknown>): boolean {
		return (
			typeof item.name === 'string' &&
			item.name.trim().length > 0 &&
			typeof item.description === 'string' &&
			item.description.trim().length > 0 &&
			typeof item.source_url === 'string' &&
			item.source_url.trim().length > 0 &&
			typeof item.category === 'string' &&
			item.category.trim().length > 0 &&
			Array.isArray(item.tags)
		);
	}

	private startStep(stepId: CodexStepId, onLogEntry?: PipelineExecutionOptions['onLogEntry']): number {
		this.setState(stepId, 'running');
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_started',
			level: 'info',
			message: this.getStepName(stepId)
		});
		return Date.now();
	}

	private completeStep(
		stepId: CodexStepId,
		startedAt: number,
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): void {
		this.setState(stepId, 'completed');
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_completed',
			level: 'info',
			message: this.getStepName(stepId),
			durationMs: Date.now() - startedAt
		});
	}

	private failStep(stepId: CodexStepId, error: Error, onLogEntry?: PipelineExecutionOptions['onLogEntry']): void {
		this.setState(stepId, 'failed', error.message);
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_failed',
			level: 'error',
			message: `${this.getStepName(stepId)}: ${this.truncateLogMessage(error.message)}`
		});
	}

	private skipStep(stepId: CodexStepId, message: string, onLogEntry?: PipelineExecutionOptions['onLogEntry']): void {
		this.setState(stepId, 'skipped' as StepStatus);
		this.emitCodexLog({
			onLogEntry,
			stepId,
			event: 'step_skipped',
			level: 'info',
			message
		});
	}

	private emitCodexLog({
		onLogEntry,
		stepId,
		message,
		...log
	}: {
		readonly onLogEntry?: PipelineExecutionOptions['onLogEntry'];
		readonly stepId?: CodexStepId;
		readonly event: 'step_started' | 'step_completed' | 'step_failed' | 'step_skipped' | 'message';
		readonly level: 'info' | 'warn' | 'error' | 'debug';
		readonly message: string;
		readonly durationMs?: number;
	}): void {
		if (!onLogEntry) {
			return;
		}

		const stepContext = stepId ? STEP_CONTEXT_BY_ID.get(stepId) : undefined;
		onLogEntry({
			timestamp: new Date().toISOString(),
			source: 'pipeline',
			stepIndex: stepContext?.stepIndex ?? null,
			stepName: stepContext?.stepName ?? null,
			message: this.truncateLogMessage(message),
			...log
		});
	}

	private getStepName(stepId: CodexStepId): string {
		return STEP_CONTEXT_BY_ID.get(stepId)?.stepName ?? stepId;
	}

	private getRunningStepId(): CodexStepId | undefined {
		if (!this.state) {
			return undefined;
		}

		for (const stepId of STEP_DEFINITIONS.map((step) => step.id)) {
			if (this.state.steps.get(stepId)?.status === 'running') {
				return stepId;
			}
		}
		return undefined;
	}

	private setState(stepId: CodexStepId, status: StepStatus, error?: string): void {
		if (this.state) {
			this.state = updateStepState(this.state, stepId, status, error);
		}
	}

	private truncateLogMessage(message: string): string {
		return message.trim().slice(0, LOG_MESSAGE_MAX_LENGTH);
	}

	private extractErrorDetail(result: ExecuteResult): string {
		const stderr = result.stderr?.trim();
		const stdout = result.stdout?.trim();
		const combined = [stderr, stdout].filter(Boolean).join('\n');

		if (combined.includes('Reading additional input from stdin')) {
			return 'Codex requested interactive input. Your API key may be invalid, missing model/billing access, or you may need to run `codex login`.';
		}

		if (stderr) {
			return stderr.split('\n')[0].slice(0, LOG_MESSAGE_MAX_LENGTH);
		}
		if (stdout) {
			return stdout.split('\n')[0].slice(0, LOG_MESSAGE_MAX_LENGTH);
		}
		return `exit code ${result.exitCode}`;
	}

	private async validateApiKey(apiKey: string, model: string): Promise<boolean> {
		const payload = JSON.stringify({
			model,
			input: 'Reply with OK.',
			max_output_tokens: 8
		});

		return new Promise<boolean>((resolve) => {
			const request = https.request(
				'https://api.openai.com/v1/responses',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(payload),
						authorization: `Bearer ${apiKey}`
					}
				},
				(response) => {
					response.resume();
					resolve((response.statusCode || 500) < 400);
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

	private async validateCliAuth(settings: Record<string, unknown>): Promise<boolean> {
		const executionAuth = await resolveExecutionAuth(settings);
		if (!executionAuth || executionAuth.mode !== 'local') {
			return false;
		}

		const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-validate-'));
		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), 12_000);

		try {
			const { promise, kill } = executeCodex({
				command: 'codex',
				cwd: workspacePath,
				env: executionAuth.env,
				model: typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL,
				bypassApprovalsAndSandbox: settings.unsafeBypassSandbox === true,
				prompt: 'Reply with exactly OK and do not read from stdin, ask follow-up questions, or modify files.',
				signal: abortController.signal
			});

			abortController.signal.addEventListener('abort', kill, { once: true });

			const result = await promise;
			const detail = this.extractErrorDetail(result);
			return result.exitCode === 0 && !detail.includes('interactive input');
		} catch {
			return false;
		} finally {
			clearTimeout(timeout);
			fs.rmSync(workspacePath, { recursive: true, force: true });
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

	private async runScreenshotCapture(
		request: GenerationRequest,
		execContext: PipelineExecutionOptions['execContext'],
		items: { name: string; source_url?: string; images?: string[] }[],
		userId: string,
		directoryId: string,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: { warn(...args: unknown[]): void },
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
			return [];
		}

		const startedAt = this.startStep('capture-screenshots', onLogEntry);
		reportProgress(onProgress, 4, 90, 'Capture Screenshots');

		const facadeOptions: FacadeOptions = {
			userId,
			directoryId
		};

		const result = await captureScreenshots(items as never[], {
			screenshotFacade,
			facadeOptions,
			signal,
			logger
		});

		if (result.status === 'failed') {
			this.failStep('capture-screenshots', new Error('Screenshot capture failed'), onLogEntry);
		} else {
			this.completeStep('capture-screenshots', startedAt, onLogEntry);
		}

		return result.errors;
	}
}

export default CodexPlugin;
