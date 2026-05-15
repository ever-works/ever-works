import type {
	AiModel,
	ConnectionValidationResult,
	FacadeOptions,
	WorkReference,
	ExistingItems,
	IDeviceAuthProvider,
	FormFieldDefinition,
	FormFieldGroup,
	GenerationRequest,
	IFormSchemaProvider,
	IPlugin,
	IPipelinePlugin,
	ICodeEditPlugin,
	CodeEditRequest,
	CodeEditOptions,
	CodeEditResult,
	JsonSchema,
	DeviceAuthStatus,
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
import {
	buildSuccessPipelineResult,
	buildDefaultCodeEditSystemPrompt,
	computeWorkspaceFileChanges,
	normalizeItemTags,
	PLUGIN_CAPABILITIES,
	substituteVariables,
	type ItemData
} from '@ever-works/plugin';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

import type { CodexStepId } from './types.js';
import { DEFAULT_MODEL } from './types.js';
import { DEFAULT_CLI_VERSION } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	DEFAULT_TARGET_ITEMS,
	getDefaultValues as formDefaults,
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate
} from './form-schema.js';
import {
	buildSystemPromptVariables,
	buildUserPromptVariables,
	DEFAULT_SYSTEM_PROMPT,
	DEFAULT_USER_PROMPT
} from './prompt/system-prompt.js';
import { PROMPT_KEYS } from './prompt-keys.js';
import { executeCodex, type ExecuteResult } from './utils/process-runner.js';
import { ensureBinary } from './utils/binary-manager.js';
import { getDeviceAuthStatus, isCodexInstalled, startDeviceAuth, verifyDeviceAuthConnection } from './device-auth.js';
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
	cleanupDeviceAuthHome,
	DEVICE_AUTH_AUTH_JSON_SETTING,
	hasDeviceCodexAuth,
	initializeState,
	materializeDeviceAuthHome,
	reportItemProgress,
	reportProgress,
	resolveExecutionAuth,
	resolveSettings,
	updateStepState
} from './utils/pipeline-helpers.js';
import { startTaxonomyWatcher } from './utils/taxonomy-watcher.js';

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
	capabilities: ['pipeline', 'form-schema-provider', 'device-auth'],
	description: 'Full pipeline plugin that delegates the entire generation to Codex',
	author: { name: 'Ever Works Team' },
	license: 'AGPL-3.0',
	builtIn: true,
	autoEnable: false,
	visibility: 'public',
	selectableProviderCategories: ['screenshot'],
	icon: {
		type: 'svg',
		value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Codex</title><path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"></path><path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#lobe-icons-codex-_R_0_)"></path><defs><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-codex-_R_0_" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"></stop><stop offset=".5" stop-color="#7A9DFF"></stop><stop offset="1" stop-color="#3941FF"></stop></linearGradient></defs></svg>`
	},
	uiHints: {
		byok: {
			buttonLabel: 'Bring your own key',
			triggerField: 'apiKey'
		},
		onboardingWizard: true,
		includeInOnboarding: true,
		onboardingPriority: 2,
		onboardingDescription:
			'Connect Codex with an OpenAI API key or a user-scoped device authentication flow for end-to-end work generation.',
		deviceAuth: {
			authModeField: 'authMode'
		},
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
		'Use Codex as the pipeline engine for work generation inside Ever Works.',
		'',
		'Codex researches sources, generates structured work items, and returns the finished results to Ever Works as a complete pipeline run.',
		'',
		'Choose this plugin when you want Codex to handle the full research and generation workflow instead of combining separate search and AI providers manually.',
		'',
		'## What It Does',
		'',
		'- Researches sources for the current work topic.',
		'- Generates structured item data for Ever Works.',
		'- Reuses your work context and existing items during generation.',
		'- Can work with screenshot providers for item imagery.',
		'',
		'## Authentication',
		'',
		'- **API Key**: connect with an OpenAI API key.',
		'- **Device Auth**: start the device flow from Ever Works, open the verification page, and enter the displayed code to connect your account.',
		'',
		'Authentication is user-scoped in Ever Works, so one user setup does not replace another.',
		'',
		'## Usage',
		'',
		'1. Connect Codex with API key or device auth.',
		'2. Enable the plugin for a work.',
		'3. Select `codex` as the pipeline provider for generation.'
	].join('\n'),
	homepage: 'https://github.com/openai/codex'
};

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

export class CodexPlugin
	implements IPlugin, IPipelinePlugin, IFormSchemaProvider, IDeviceAuthProvider, ICodeEditPlugin
{
	readonly id = 'codex';
	readonly name = 'Codex Generator';
	readonly providerName = 'OpenAI Codex';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.PIPELINE,
		PLUGIN_CAPABILITIES.FORM_SCHEMA_PROVIDER,
		PLUGIN_CAPABILITIES.DEVICE_AUTH,
		PLUGIN_CAPABILITIES.CODE_EDIT
	] as const;
	readonly configurationMode = 'user-required' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			authMode: {
				type: 'string',
				title: 'Authentication Mode',
				description: 'Choose whether Codex uses an OpenAI API key or user-scoped device authentication.',
				enum: ['api-key', 'device-auth'],
				default: 'api-key',
				'x-scope': 'user',
				'x-hidden': true
			},
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'OpenAI API key for Codex CLI execution',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'OPENAI_API_KEY'
			},
			[DEVICE_AUTH_AUTH_JSON_SETTING]: {
				type: 'string',
				title: 'Device Auth Session',
				description: 'Portable device-auth payload used to materialize a runtime CODEX_HOME for Codex CLI.',
				'x-secret': true,
				'x-scope': 'user',
				'x-hidden': true
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
	private codexCommandPath: string | null = null;

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
		return MANIFEST;
	}

	async listModels(): Promise<readonly AiModel[]> {
		return CODEX_SUPPORTED_MODELS;
	}

	private getRealSecret(value: unknown): string | undefined {
		if (typeof value !== 'string' || !value || value.includes('••••')) return undefined;
		return value;
	}

	private async persistDeviceAuthPayload(userId: string, authJson: string): Promise<void> {
		if (!this.context) {
			return;
		}

		await this.context.updateSettings('user', userId, {
			settings: { authMode: 'device-auth' },
			secretSettings: {
				[DEVICE_AUTH_AUTH_JSON_SETTING]: authJson
			}
		});
	}

	private async getPersistedDeviceAuthStatus(userId: string): Promise<DeviceAuthStatus | null> {
		if (!this.context) {
			return null;
		}

		const settings = await this.context.getSettings('user', userId);
		const authJson = this.getRealSecret(settings[DEVICE_AUTH_AUTH_JSON_SETTING]);
		if (!authJson) {
			return null;
		}

		const installed = await isCodexInstalled(this.context.logger);

		return {
			installed,
			connected: true,
			pending: false,
			scope: 'user',
			flowType: 'device-code',
			message: 'Codex device authentication is connected for this user.'
		};
	}

	async isAvailable(settings?: Record<string, unknown>): Promise<boolean> {
		const resolved = settings || {};
		const authMode = typeof resolved.authMode === 'string' ? resolved.authMode : undefined;
		const apiKey = this.getRealSecret(resolved.apiKey)?.trim() ?? '';
		const model = typeof resolved.model === 'string' ? resolved.model : DEFAULT_MODEL;

		if (authMode === 'api-key') {
			return apiKey ? this.validateApiKey(apiKey, model) : false;
		}

		if (authMode === 'device-auth') {
			return this.validateCliAuth(resolved);
		}

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
		if (settings.authMode !== undefined && settings.authMode !== 'api-key' && settings.authMode !== 'device-auth') {
			return {
				valid: false,
				errors: [{ path: 'authMode', message: 'Authentication mode must be "api-key" or "device-auth"' }]
			};
		}
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
		const authMode = typeof settings.authMode === 'string' ? settings.authMode : undefined;
		const apiKey = this.getRealSecret(settings.apiKey)?.trim() ?? '';
		const model = typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL;
		if (authMode === 'api-key') {
			if (!apiKey) {
				return {
					success: false,
					message: 'Provide an OpenAI API key or switch to device authentication first.'
				};
			}

			const valid = await this.validateApiKey(apiKey, model);
			return valid
				? { success: true, message: 'OpenAI API key verified for Codex.' }
				: {
						success: false,
						message:
							'OpenAI API key validation failed. Verify the key, model access, and billing, or switch to device authentication.'
					};
		}

		if (authMode === 'device-auth') {
			if (!(await hasDeviceCodexAuth(settings))) {
				return {
					success: false,
					message:
						'Codex device authentication is not configured for this user. Complete device auth first or configure an OpenAI API key.'
				};
			}

			const valid = await this.validateCliAuth(settings);
			return valid
				? { success: true, message: 'Codex device authentication verified.' }
				: {
						success: false,
						message:
							'Codex device authentication could not be verified. Restart the device-auth flow or switch to an OpenAI API key.'
					};
		}

		if (apiKey) {
			const valid = await this.validateApiKey(apiKey, model);
			return valid
				? { success: true, message: 'OpenAI API key verified for Codex.' }
				: {
						success: false,
						message:
							'OpenAI API key validation failed. Verify the key, model access, and billing, or use device authentication.'
					};
		}

		if (await hasDeviceCodexAuth(settings)) {
			const valid = await this.validateCliAuth(settings);
			return valid
				? { success: true, message: 'Codex device authentication verified.' }
				: {
						success: false,
						message:
							'Codex device authentication could not be verified. Restart the device-auth flow or provide an OpenAI API key.'
					};
		}

		return {
			success: false,
			message: 'Configure an OpenAI API key or start Codex device authentication first.'
		};
	}

	async getDeviceAuthStatus(userId: string): Promise<DeviceAuthStatus> {
		const persisted = await this.getPersistedDeviceAuthStatus(userId);
		if (persisted) {
			return persisted;
		}

		return getDeviceAuthStatus(userId, this.context?.logger ?? console, async (authJson) =>
			this.persistDeviceAuthPayload(userId, authJson)
		);
	}

	async startDeviceAuth(userId: string): Promise<DeviceAuthStatus> {
		const persisted = await this.getPersistedDeviceAuthStatus(userId);
		if (persisted) {
			return persisted;
		}

		return startDeviceAuth(userId, this.context?.logger ?? console, async (authJson) =>
			this.persistDeviceAuthPayload(userId, authJson)
		);
	}

	async execute(
		work: WorkReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		if (this.abortController) {
			return this.handleError(
				new Error(
					'Codex Generator is already executing another generation. Wait for it to finish or cancel it first.'
				),
				startTime
			);
		}

		this.state = initializeState();
		const abortController = new AbortController();
		this.abortController = abortController;

		if (options?.signal) {
			if (options.signal.aborted) {
				abortController.abort();
			} else {
				options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
			}
		}

		const signal = abortController.signal;
		const onLogEntry = options?.onLogEntry;
		const logger = this.context?.logger ?? console;
		const userId = work.user?.id ?? 'system';

		let workspaceCreated = false;
		let workspacePath: string | null = null;
		let executionAuthEnv: Record<string, string> | null = null;

		try {
			const setupStartedAt = this.startStep('setup-codex', onLogEntry);
			reportProgress(onProgress, 0, 5, 'Setup Codex');

			const settings = await resolveSettings(this.context, userId, work.id);
			const executionAuth = await resolveExecutionAuth(settings);
			if (!executionAuth) {
				throw new Error(
					'No Codex authentication available. Configure an OpenAI API key or complete device authentication first.'
				);
			}

			this.codexCommandPath = await ensureBinary(DEFAULT_CLI_VERSION, this.context?.logger);

			this.emitCodexLog({
				onLogEntry,
				stepId: 'setup-codex',
				event: 'message',
				level: 'info',
				message: `Using Codex ${executionAuth.mode === 'api-key' ? 'API key' : 'device auth'} mode`
			});
			this.completeStep('setup-codex', setupStartedAt, onLogEntry);

			const prepareStartedAt = this.startStep('prepare-context', onLogEntry);
			reportProgress(onProgress, 1, 15, 'Prepare Context');

			workspacePath = await createWorkspace(userId, work.id);
			workspaceCreated = true;
			await seedExistingItems(workspacePath, existing.items);
			await seedMetadata(workspacePath, {
				work: { name: work.name, description: work.description },
				request: { prompt: request.prompt, name: request.name },
				categories: existing.categories,
				tags: existing.tags,
				brands: existing.brands,
				references: existing.references
			});

			executionAuthEnv =
				executionAuth.mode === 'api-key'
					? executionAuth.env
					: {
							CODEX_HOME: await materializeDeviceAuthHome(
								executionAuth.authJson,
								path.join(workspacePath, '_meta', 'device-auth')
							)
						};
			this.completeStep('prepare-context', prepareStartedAt, onLogEntry);

			const generateStartedAt = this.startStep('generate-items', onLogEntry);
			reportProgress(onProgress, 2, 30, 'Generate Items');

			const execContext = options?.execContext;
			const promptFacade = execContext?.promptFacade;
			const facadeOptions = { userId, workId: work.id };

			const prompt = await this.buildExecutionPrompt(
				work,
				request,
				existing,
				workspacePath,
				promptFacade,
				facadeOptions
			);

			const targetItems = ((request.config || {}).target_items as number) || DEFAULT_TARGET_ITEMS;
			const taxonomyWatcher = startTaxonomyWatcher({
				workspacePath,
				logger,
				onNewItem: (newItemCount) => {
					reportItemProgress(onProgress, newItemCount, targetItems, 2);
				}
			});

			let executionResult: ExecuteResult;
			try {
				executionResult = await this.runCodexPrompt({
					workspacePath,
					executionAuthEnv: executionAuthEnv ?? {},
					model: typeof settings.model === 'string' ? settings.model : DEFAULT_MODEL,
					bypassApprovalsAndSandbox: settings.unsafeBypassSandbox === true,
					prompt,
					signal,
					onLogEntry,
					stepId: 'generate-items'
				});
			} finally {
				taxonomyWatcher.stop();
			}

			if (signal.aborted || executionResult.killed) {
				return this.handleCancel(startTime);
			}

			let generationWarning: string | undefined;
			if (executionResult.exitCode !== 0) {
				const detail = this.extractErrorDetail(executionResult);
				logger.warn(`Codex exited with code ${executionResult.exitCode}: ${detail}`);
				generationWarning = `Codex finished with an error (${detail}).`;
				this.emitCodexLog({
					onLogEntry,
					stepId: 'generate-items',
					event: 'message',
					level: 'warn',
					message: generationWarning
				});
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
						executionAuthEnv: executionAuthEnv ?? {},
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
						const retryDetail = this.extractErrorDetail(executionResult);
						logger.warn(`Codex bypass retry exited with code ${executionResult.exitCode}: ${retryDetail}`);
						generationWarning = `Codex finished with an error (${retryDetail}).`;
					}

					items = await readGeneratedItems(workspacePath, logger);
				}

				if (items.length === 0) {
					const recoveredItems = await this.recoverItemsFromStructuredOutput({
						work,
						request,
						existing,
						workspacePath,
						settings,
						executionAuthEnv: executionAuthEnv ?? {},
						preferBypass: shouldRetryWithBypass,
						onLogEntry,
						signal
					});

					if (recoveredItems.length > 0) {
						await writeGeneratedItems(workspacePath, recoveredItems);
						items = await readGeneratedItems(workspacePath, logger);
					}
				}

				if (items.length === 0) {
					const workspaceOutputs = await describeWorkspaceOutputs(workspacePath);
					const outputSummary =
						workspaceOutputs.length > 0 ? workspaceOutputs.join(', ') : 'no visible files created';
					const stderrExcerpt = executionResult.stderr
						?.trim()
						.split('\n')
						.filter(Boolean)
						.slice(-2)
						.join(' | ');
					const stdoutExcerpt = executionResult.stdout
						?.trim()
						.split('\n')
						.filter(Boolean)
						.slice(-2)
						.join(' | ');
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
				work.id,
				signal,
				onProgress,
				logger,
				onLogEntry
			);

			const cleanupStartedAt = this.startStep('cleanup', onLogEntry);
			reportProgress(onProgress, 5, 95, 'Cleanup');
			await cleanupWorkspace(workspacePath);
			workspaceCreated = false;
			this.completeStep('cleanup', cleanupStartedAt, onLogEntry);

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
					stepsCompleted: this.state?.completedSteps.length ?? 0,
					totalSteps: STEP_DEFINITIONS.length,
					state: this.state ?? undefined,
					warnings: warnings.length > 0 ? warnings : undefined
				}
			);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const runningStepId = this.getRunningStepId();
			if (runningStepId) {
				this.failStep(runningStepId, err, onLogEntry);
			}
			if (workspaceCreated && workspacePath) {
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

	getState(): PipelineState<CodexStepId> | null {
		return this.state;
	}

	private async buildExecutionPrompt(
		work: WorkReference,
		request: GenerationRequest,
		existing: ExistingItems,
		workspacePath: string,
		promptFacade?: { getPrompt(key: string, defaultPrompt: string, options: FacadeOptions): Promise<string> },
		facadeOptions?: FacadeOptions
	): Promise<string> {
		const promptOptions = {
			work,
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

		const sysTemplate = (
			promptFacade
				? await promptFacade.getPrompt(PROMPT_KEYS.SYSTEM, DEFAULT_SYSTEM_PROMPT, facadeOptions!)
				: DEFAULT_SYSTEM_PROMPT
		) as typeof DEFAULT_SYSTEM_PROMPT;
		const systemPrompt = substituteVariables(sysTemplate, buildSystemPromptVariables(promptOptions));

		const userTemplate = (
			promptFacade
				? await promptFacade.getPrompt(PROMPT_KEYS.USER, DEFAULT_USER_PROMPT, facadeOptions!)
				: DEFAULT_USER_PROMPT
		) as typeof DEFAULT_USER_PROMPT;
		const userPrompt = substituteVariables(userTemplate, buildUserPromptVariables(promptOptions));

		return [systemPrompt, '', userPrompt].join('\n');
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
			command: this.codexCommandPath ?? 'codex',
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
		work,
		request,
		existing,
		workspacePath,
		settings,
		executionAuthEnv,
		preferBypass,
		onLogEntry,
		signal
	}: {
		readonly work: WorkReference;
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

		const recoveryPrompt = this.buildStructuredRecoveryPrompt(work, request, existing);
		const { promise, kill } = executeCodex({
			command: this.codexCommandPath ?? 'codex',
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
		work: WorkReference,
		request: GenerationRequest,
		existing: ExistingItems
	): string {
		const targetItems = Number(request.config?.target_items ?? DEFAULT_TARGET_ITEMS);
		const contextParts = [
			'The previous Codex run completed research but failed to persist item files in the workspace.',
			'This recovery run must return the final items directly as structured JSON matching the provided schema.',
			'Do not explain your work. Do not ask for another message. Do not mention sandbox limitations.',
			`Work: ${work.name}`,
			work.description ? `Work description: ${work.description}` : '',
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
		const combined = [result.stderr, result.stdout].filter(Boolean).join('\n').toLowerCase();

		const mentionsSandbox = combined.includes('sandbox');
		const mentionsWriteBlock =
			combined.includes('write the json files directly') ||
			combined.includes('write the full json files immediately') ||
			combined.includes('ready-to-save json') ||
			combined.includes('paste the full') ||
			combined.includes('next reply') ||
			combined.includes('local file tools are working') ||
			combined.includes('local execution tools') ||
			combined.includes('permission error') ||
			combined.includes('permission denied') ||
			combined.includes('could not actually create or verify') ||
			combined.includes('could not complete') ||
			combined.includes('write the researched json files directly');

		return (
			combined.includes('sandbox issue') ||
			combined.includes('sandboxed file-write blockage') ||
			combined.includes('file writes were blocked') ||
			combined.includes('local file writes were blocked') ||
			combined.includes('re-run this task in a session where local file tools are working') ||
			combined.includes('insufficient to finish the task because local file writes were blocked') ||
			(mentionsSandbox && mentionsWriteBlock)
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
		if (!executionAuth || executionAuth.mode !== 'device-auth') {
			return false;
		}

		const codexHome = await materializeDeviceAuthHome(executionAuth.authJson);
		try {
			return await verifyDeviceAuthConnection(codexHome, this.context?.logger ?? console);
		} finally {
			await cleanupDeviceAuthHome(codexHome);
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
		workId: string,
		signal: AbortSignal,
		onProgress: PipelineProgressCallback | undefined,
		logger: { warn(...args: unknown[]): void },
		onLogEntry?: PipelineExecutionOptions['onLogEntry']
	): Promise<string[]> {
		const shouldCapture = (request.config || {}).capture_screenshots === true;
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
			workId
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

	// ─────────────────────────────────────────────────────────────────────
	// Code-edit capability (ICodeEditPlugin)
	// ─────────────────────────────────────────────────────────────────────

	async executeCodeEdit(request: CodeEditRequest, options?: CodeEditOptions): Promise<CodeEditResult> {
		const startTime = Date.now();
		const settings =
			((options?.execContext as { settings?: Record<string, unknown> })?.settings as Record<string, unknown>) ??
			{};

		const executionAuth = await resolveExecutionAuth(settings);
		if (!executionAuth) {
			return {
				success: false,
				summary: 'No Codex authentication available',
				filesChanged: [],
				duration: Date.now() - startTime,
				error: 'Configure an OpenAI API key or complete Codex device authentication first.'
			};
		}
		if (executionAuth.mode !== 'api-key') {
			return {
				success: false,
				summary: 'Codex device-auth mode is not yet supported for code-edit',
				filesChanged: [],
				duration: Date.now() - startTime,
				error: 'Use api-key mode for code-edit runs (device-auth follow-up tracked in EW-550).'
			};
		}

		const cliVersion = (settings.version as string) || DEFAULT_CLI_VERSION;
		this.codexCommandPath = await ensureBinary(cliVersion, this.context?.logger);

		const model = request.model ?? (settings.model as string | undefined) ?? DEFAULT_MODEL;
		const systemPrompt = buildDefaultCodeEditSystemPrompt(request);
		const fullPrompt = `${systemPrompt}\n\n---\n\nUser request:\n${request.prompt}`;

		const { promise, kill } = executeCodex({
			command: this.codexCommandPath ?? 'codex',
			cwd: request.workspaceDir,
			env: executionAuth.env,
			model,
			bypassApprovalsAndSandbox: true,
			prompt: fullPrompt,
			signal: options?.signal,
			onStdoutLine: options?.onLogLine ? (line) => options.onLogLine!('stdout', line) : undefined,
			onStderrLine: options?.onLogLine ? (line) => options.onLogLine!('stderr', line) : undefined
		});

		this.killProcess = kill;
		const result = await promise;
		this.killProcess = null;

		if (result.killed || options?.signal?.aborted) {
			return {
				success: false,
				summary: 'Code edit cancelled',
				filesChanged: [],
				duration: Date.now() - startTime,
				error: 'Cancelled'
			};
		}

		const filesChanged = await computeWorkspaceFileChanges(request.workspaceDir);
		const success = result.exitCode === 0 && filesChanged.length > 0;
		const summary = success
			? `Codex modified ${filesChanged.length} file(s) in ${Math.round((Date.now() - startTime) / 1000)}s`
			: result.exitCode === 0
				? 'Codex ran but produced no changes'
				: `Codex exited with code ${result.exitCode}`;

		return {
			success,
			summary,
			filesChanged,
			duration: Date.now() - startTime,
			error: success ? undefined : result.stderr || `Exit ${result.exitCode}`,
			extra: { exitCode: result.exitCode }
		};
	}

	async cancelCodeEdit(): Promise<void> {
		this.killProcess?.();
		this.killProcess = null;
	}
}

export default CodexPlugin;
