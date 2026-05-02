import type {
	AiModel,
	ConnectionValidationResult,
	WorkReference,
	ExistingItems,
	FormFieldDefinition,
	FormFieldGroup,
	GenerationRequest,
	IFormSchemaProvider,
	IPipelinePlugin,
	JsonSchema,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	PipelineState,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	ValidationResult
} from '@ever-works/plugin';
import { buildSuccessPipelineResult } from '@ever-works/plugin';

import {
	getDefaultValues,
	getFormFields,
	getFormGroups,
	validateFormInput,
	DEFAULT_TARGET_ITEMS
} from './form-schema.js';
import { README } from './readme.js';
import { STEP_DEFINITIONS } from './steps.js';
import {
	CLAUDE_MANAGED_AGENT_SUPPORTED_MODELS,
	type ClaudeManagedAgentStepId,
	DEFAULT_BASE_URL,
	DEFAULT_MAX_POLL_ATTEMPTS,
	DEFAULT_MODEL,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_WORKSPACE_PATH,
	type ManagedAgentRunResources,
	WORKSPACE_SEED_MANIFEST_MOUNT_PATH
} from './types.js';
import { cleanupManagedAgentRun } from './utils/managed-agents-cleanup.js';
import { AnthropicManagedAgentsClient } from './utils/managed-agents-client.js';
import {
	buildCancelledResult,
	buildErrorResult,
	buildMetrics,
	finalizeCompletedState,
	getNumericSetting,
	getStepProgressContext,
	getUsableSecret,
	initializeState,
	reportProgress,
	resolveManagedAgentSettings,
	updateStepState
} from './utils/pipeline-helpers.js';
import {
	buildResultCollectionPrompt,
	buildSystemPrompt,
	buildUserPrompt,
	buildWorkspaceSeedPrompt
} from './utils/prompt-builder.js';
import { extractAgentTranscript, normalizeOutputs, parseStructuredOutput } from './utils/result-parser.js';
import { captureScreenshots } from './utils/screenshot-capture.js';
import { buildWorkspaceSeedManifest } from './utils/workspace-seed.js';

const MANIFEST: PluginManifest = {
	id: 'claude-managed-agent',
	name: 'Claude Managed Agent',
	version: '1.0.0',
	description: 'Full pipeline plugin that delegates work generation to Anthropic Claude Managed Agents',
	category: 'pipeline',
	capabilities: ['pipeline', 'form-schema-provider'],
	author: { name: 'Ever Works Team' },
	license: 'MIT',
	builtIn: true,
	autoEnable: false,
	visibility: 'public',
	selectableProviderCategories: ['screenshot'],
	readme: README,
	homepage: 'https://platform.claude.com/docs/en/managed-agents/overview',
	icon: {
		type: 'svg',
		value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Claude</title><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fill-rule="nonzero"></path></svg>`
	}
};

export class ClaudeManagedAgentPlugin implements IPipelinePlugin<ClaudeManagedAgentStepId>, IFormSchemaProvider {
	readonly id = 'claude-managed-agent';
	readonly name = 'Claude Managed Agent';
	readonly version = '1.0.0';
	readonly category = 'pipeline' as const;
	readonly capabilities = ['pipeline', 'form-schema-provider'] as const;
	readonly configurationMode = 'hybrid' as const;
	readonly handledConfigFields = ['*'] as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Anthropic API Key',
				description: 'API key used for Anthropic Claude Managed Agents.',
				'x-secret': true,
				'x-scope': 'user'
			},
			model: {
				type: 'string',
				title: 'Model',
				description: 'Managed Agents model ID to use for the session.',
				default: DEFAULT_MODEL,
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'Anthropic API base URL.',
				default: DEFAULT_BASE_URL,
				'x-hidden': true,
				'x-scope': 'global'
			},
			pollIntervalMs: {
				type: 'integer',
				title: 'Poll Interval',
				description: 'Polling interval used while waiting for the session to finish.',
				default: DEFAULT_POLL_INTERVAL_MS,
				minimum: 500,
				maximum: 10000,
				'x-hidden': true,
				'x-scope': 'global'
			},
			maxPollAttempts: {
				type: 'integer',
				title: 'Max Poll Attempts',
				description:
					'Maximum polling attempts before the session is treated as timed out. With the default 2 second polling interval, 3600 attempts is about 2 hours.',
				default: DEFAULT_MAX_POLL_ATTEMPTS,
				minimum: 10,
				maximum: 3600,
				'x-hidden': true,
				'x-scope': 'global'
			}
		},
		required: ['apiKey']
	};

	private context: PluginContext | null = null;
	private state: PipelineState<ClaudeManagedAgentStepId> | null = null;
	private abortController: AbortController | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Claude Managed Agent plugin loaded');
	}

	async onUnload(): Promise<void> {
		await this.cancel();
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Claude Managed Agent plugin is ready',
			checkedAt: Date.now()
		};
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const apiKey = getUsableSecret(settings.apiKey);
		if (!apiKey) {
			return {
				success: false,
				message: 'No Anthropic API key configured.'
			};
		}

		try {
			const client = new AnthropicManagedAgentsClient(
				apiKey,
				(settings.baseUrl as string | undefined) || DEFAULT_BASE_URL
			);
			await client.validateAccess();

			return {
				success: true,
				message: 'Anthropic Managed Agents credentials verified.'
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				message: `Anthropic Managed Agents validation failed: ${message}`
			};
		}
	}

	async listModels(): Promise<readonly AiModel[]> {
		return CLAUDE_MANAGED_AGENT_SUPPORTED_MODELS;
	}

	getManifest(): PluginManifest {
		return MANIFEST;
	}

	getFormFields(): FormFieldDefinition[] {
		return getFormFields();
	}

	getFormGroups(): FormFieldGroup[] {
		return getFormGroups();
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		return validateFormInput(values);
	}

	getDefaultValues(): Record<string, unknown> {
		return getDefaultValues(this.getFormFields());
	}

	getStepDefinitions() {
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
		const execContext = options?.execContext;

		if (!execContext?.user?.id) {
			return this.toErrorResult(
				new Error('User context is required for Claude Managed Agent execution.'),
				startTime
			);
		}

		const abortController = new AbortController();
		this.abortController = abortController;
		options?.signal?.addEventListener('abort', () => abortController.abort(options.signal?.reason), {
			once: true
		});

		this.state = initializeState();

		const userId = execContext.user.id;
		const logger = this.context?.logger ?? console;
		const config = request.config || {};
		const targetItems = this.getTargetItems(config);
		const shouldCaptureScreenshots = config.capture_screenshots !== false;
		let client: AnthropicManagedAgentsClient | null = null;
		const runResources: ManagedAgentRunResources = {};

		try {
			await this.beginStep('configure-managed-agent', onProgress, 5);

			const settings = await resolveManagedAgentSettings(this.context, userId, work.id);
			const apiKey = getUsableSecret(settings.apiKey);
			if (!apiKey) {
				throw new Error('Anthropic API key is required for the Claude Managed Agent plugin.');
			}

			client = new AnthropicManagedAgentsClient(
				apiKey,
				(settings.baseUrl as string | undefined) || DEFAULT_BASE_URL
			);
			const model = (settings.model as string | undefined) || DEFAULT_MODEL;
			const systemPrompt = buildSystemPrompt();
			const workspaceSeedManifest = buildWorkspaceSeedManifest(DEFAULT_WORKSPACE_PATH, work, request, existing);
			const uploadedSeedManifest = await client.uploadTextFile(
				'ever-works-workspace-seed.json',
				JSON.stringify(workspaceSeedManifest, null, 2)
			);
			runResources.uploadedFileId = uploadedSeedManifest.id;

			const agentId = (
				await client.createAgent({
					name: `Ever Works Agent: ${work.slug}`,
					description: `Managed Ever Works generation agent for ${work.slug}`,
					model,
					system: systemPrompt
				})
			).id;
			runResources.createdAgentId = agentId;

			const environmentId = (
				await client.createEnvironment({
					name: `Ever Works Environment: ${work.slug}`
				})
			).id;
			runResources.createdEnvironmentId = environmentId;

			this.completeStep('configure-managed-agent');

			if (abortController.signal.aborted) {
				return this.toCancelledResult(startTime).result;
			}

			await this.beginStep('run-managed-session', onProgress, 20);

			const session = await client.createSession({
				agentId,
				environmentId,
				title: `Ever Works: ${work.name}`,
				resources: [
					{
						type: 'file',
						file_id: uploadedSeedManifest.id,
						mount_path: WORKSPACE_SEED_MANIFEST_MOUNT_PATH
					}
				]
			});
			runResources.sessionId = session.id;

			await client.sendUserMessage(session.id, buildWorkspaceSeedPrompt(workspaceSeedManifest));

			await client.waitForSessionIdle(session.id, {
				maxPollAttempts: getNumericSetting(settings.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS),
				pollIntervalMs: getNumericSetting(settings.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
				signal: abortController.signal
			});

			const seedEvents = await client.listAllEvents(session.id);
			const seedEventIds = new Set(seedEvents.map((event) => event.id));

			await client.sendUserMessage(
				session.id,
				buildUserPrompt(work, request, existing, targetItems, DEFAULT_WORKSPACE_PATH)
			);

			await client.waitForSessionIdle(session.id, {
				maxPollAttempts: getNumericSetting(settings.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS),
				pollIntervalMs: getNumericSetting(settings.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
				signal: abortController.signal,
				onPoll: (_currentSession, attempt) => {
					const maxPollAttempts = getNumericSetting(settings.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS);
					const percent = 25 + Math.min(50, Math.floor((attempt / Math.max(maxPollAttempts, 1)) * 50));
					const step = getStepProgressContext('run-managed-session');
					reportProgress(onProgress, step.stepIndex, percent, step.stepName);
				}
			});

			const generationEvents = (await client.listAllEvents(session.id)).filter(
				(event) => !seedEventIds.has(event.id)
			);
			const generationIdleEvent = [...generationEvents]
				.reverse()
				.find((event) => event.type === 'session.status_idle');
			const generationStopReasonType = generationIdleEvent?.stop_reason?.type;

			if (generationStopReasonType === 'requires_action') {
				throw new Error(
					'Claude Managed Agents paused for external action. This plugin currently supports only fully autonomous sessions without custom tool confirmations.'
				);
			}

			const generationEventIds = new Set(generationEvents.map((event) => event.id));

			await client.sendUserMessage(session.id, buildResultCollectionPrompt(DEFAULT_WORKSPACE_PATH));

			const finalSession = await client.waitForSessionIdle(session.id, {
				maxPollAttempts: getNumericSetting(settings.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS),
				pollIntervalMs: getNumericSetting(settings.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
				signal: abortController.signal
			});

			this.completeStep('run-managed-session');

			if (abortController.signal.aborted) {
				return this.toCancelledResult(startTime).result;
			}

			await this.beginStep('parse-agent-output', onProgress, 80);

			const events = (await client.listAllEvents(session.id)).filter(
				(event) => !seedEventIds.has(event.id) && !generationEventIds.has(event.id)
			);
			const idleEvent = [...events].reverse().find((event) => event.type === 'session.status_idle');
			const stopReasonType = idleEvent?.stop_reason?.type;

			if (stopReasonType === 'requires_action') {
				throw new Error(
					'Claude Managed Agents paused for external action. This plugin currently supports only fully autonomous sessions without custom tool confirmations.'
				);
			}

			const transcript = extractAgentTranscript(events);
			if (!transcript) {
				throw new Error('Claude Managed Agents finished without returning an agent message.');
			}

			const structuredOutput = parseStructuredOutput(transcript);
			const warnings = [...(structuredOutput.warnings || [])];
			const normalizedOutputs = normalizeOutputs(structuredOutput);

			this.completeStep('parse-agent-output');

			if (abortController.signal.aborted) {
				return this.toCancelledResult(startTime, normalizedOutputs).result;
			}

			if (shouldCaptureScreenshots && execContext.screenshotFacade?.isAvailable()) {
				await this.beginStep('capture-screenshots', onProgress, 92);

				const screenshotWarnings = await captureScreenshots(
					normalizedOutputs.items,
					execContext.screenshotFacade,
					{
						userId,
						workId: work.id
					},
					abortController.signal,
					logger
				);
				warnings.push(...screenshotWarnings);
				this.completeStep('capture-screenshots');
			} else {
				this.skipStep('capture-screenshots');
			}

			const completeStep = getStepProgressContext('capture-screenshots');
			reportProgress(onProgress, completeStep.stepIndex, 100, 'Complete');
			this.state = finalizeCompletedState(this.state ?? initializeState());

			return buildSuccessPipelineResult(normalizedOutputs, {
				duration: Date.now() - startTime,
				stepsCompleted: this.state.completedSteps.length,
				totalSteps: STEP_DEFINITIONS.length,
				state: this.state,
				metrics: finalSession.usage
					? buildMetrics(startTime, Date.now() - startTime, normalizedOutputs.items.length, {
							usage: finalSession.usage
						})
					: undefined,
				warnings
			});
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Claude Managed Agent pipeline failed: ${err.message}`);
			return this.toErrorResult(err, startTime);
		} finally {
			if (client) {
				await cleanupManagedAgentRun(client, runResources, {
					warn: (message) => logger.warn(message)
				});
			}
			this.abortController = null;
		}
	}

	async cancel(): Promise<void> {
		this.abortController?.abort(new Error('Pipeline cancelled'));
	}

	getState(): PipelineState<ClaudeManagedAgentStepId> | null {
		return this.state;
	}

	private async beginStep(
		stepId: ClaudeManagedAgentStepId,
		onProgress: PipelineProgressCallback | undefined,
		percent: number
	): Promise<void> {
		this.state = updateStepState(this.state ?? initializeState(), stepId, 'running');
		const step = getStepProgressContext(stepId);
		reportProgress(onProgress, step.stepIndex, percent, step.stepName);
	}

	private completeStep(stepId: ClaudeManagedAgentStepId): void {
		this.state = updateStepState(this.state ?? initializeState(), stepId, 'completed');
	}

	private skipStep(stepId: ClaudeManagedAgentStepId): void {
		this.state = updateStepState(this.state ?? initializeState(), stepId, 'skipped');
	}

	private toCancelledResult(startTime: number, outputs?: PipelineResult['outputs']) {
		const result = buildCancelledResult(this.state, startTime, outputs);
		this.state = result.state;
		return result;
	}

	private toErrorResult(error: Error, startTime: number): PipelineResult {
		const result = buildErrorResult(this.state, error, startTime);
		this.state = result.state;
		return result.result;
	}

	private getTargetItems(config: Record<string, unknown>): number {
		const value = config.target_items;
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			return value;
		}

		return DEFAULT_TARGET_ITEMS;
	}
}

export type { ClaudeManagedAgentStepId } from './types.js';

export default ClaudeManagedAgentPlugin;
