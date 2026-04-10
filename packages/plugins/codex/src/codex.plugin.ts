import type {
	AiModel,
	ConnectionValidationResult,
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
	ValidationResult
} from '@ever-works/plugin';
import { buildErrorPipelineResult, createEmptyPipelineOutputs, lucideIcon } from '@ever-works/plugin';

import type { CodexStepId } from './types.js';
import { DEFAULT_MODEL } from './types.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	getDefaultValues as formDefaults,
	getFormFields as formFields,
	getFormGroups as formGroups,
	validateFormInput as formValidate
} from './form-schema.js';

const CODEX_SUPPORTED_MODELS: readonly AiModel[] = [
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
	icon: lucideIcon('sparkles'),
	uiHints: {
		byok: {
			buttonLabel: 'Bring your own key',
			triggerField: 'apiKey'
		},
		setupLink: {
			url: 'https://platform.openai.com/account/api-keys',
			label: 'OpenAI API keys',
			buttonLabel: 'Get API key',
			showWhenEmpty: ['apiKey']
		},
		completionFields: ['apiKey']
	}
};

function createInitialState(): PipelineState<CodexStepId> {
	return {
		steps: new Map(
			STEP_DEFINITIONS.map((definition) => [
				definition.id,
				{
					definition,
					status: 'pending'
				}
			])
		),
		completedSteps: [],
		failedSteps: [],
		isRunning: false,
		isCancelled: false
	};
}

function createFailedState(
	failedStep: CodexStepId,
	startedAt: number,
	completedAt: number
): PipelineState<CodexStepId> {
	const steps = new Map(
		STEP_DEFINITIONS.map((definition) => [
			definition.id,
			{
				definition,
				status: definition.id === failedStep ? ('failed' as const) : ('pending' as const),
				startedAt: definition.id === failedStep ? startedAt : undefined,
				completedAt: definition.id === failedStep ? completedAt : undefined,
				error: definition.id === failedStep ? 'Codex pipeline execution is not implemented yet' : undefined
			}
		])
	);

	return {
		steps,
		currentStep: failedStep,
		completedSteps: [],
		failedSteps: [failedStep],
		isRunning: false,
		isCancelled: false,
		startedAt,
		completedAt
	};
}

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
			}
		},
		required: ['apiKey']
	};

	private context: PluginContext | null = null;
	private state: PipelineState<CodexStepId> | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.state = createInitialState();
		context.logger.log('Codex Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.state = createInitialState();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Codex Generator plugin scaffold is loaded',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return MANIFEST;
	}

	async listModels(): Promise<readonly AiModel[]> {
		return CODEX_SUPPORTED_MODELS;
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
		if (typeof settings.apiKey !== 'string' || settings.apiKey.trim().length === 0) {
			return {
				valid: false,
				errors: [
					{
						path: 'apiKey',
						message: 'OpenAI API key is required for the Codex plugin'
					}
				]
			};
		}

		return { valid: true };
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const validation = this.validateSettings(settings);
		if (!validation.valid) {
			return {
				success: false,
				message: validation.errors?.[0]?.message ?? 'Codex configuration is invalid'
			};
		}

		return {
			success: true,
			message: 'Codex configuration looks valid'
		};
	}

	async execute(
		_directory: DirectoryReference,
		_request: GenerationRequest,
		_existing: ExistingItems,
		_options?: PipelineExecutionOptions,
		_onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		const startTime = Date.now();
		const completedAt = Date.now();
		this.state = createFailedState('setup-codex', startTime, completedAt);

		return buildErrorPipelineResult('Codex pipeline execution is not implemented yet', {
			duration: completedAt - startTime,
			stepsCompleted: 0,
			totalSteps: STEP_DEFINITIONS.length,
			failedStep: 'setup-codex',
			outputs: createEmptyPipelineOutputs(),
			state: this.state ?? undefined
		});
	}

	async cancel(): Promise<void> {
		this.state = {
			...(this.state ?? createInitialState()),
			isRunning: false,
			isCancelled: true,
			completedAt: Date.now()
		};
	}

	getState(): PipelineState<CodexStepId> | null {
		return this.state;
	}
}

export default CodexPlugin;
