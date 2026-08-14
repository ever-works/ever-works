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
	clampPerSessionBudgetUsd,
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
	CMA_FAN_OUT_CAPABILITY,
	DEFAULT_BASE_URL,
	DEFAULT_MAX_POLL_ATTEMPTS,
	DEFAULT_MODEL,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_WORKSPACE_PATH,
	type ManagedAgentFanOutCapability,
	type ManagedAgentRunResources,
	type ManagedRuntimeEnvironment,
	type ManagedSessionRunResult,
	MAX_VARIANT_SESSIONS,
	MIN_VARIANT_SESSIONS,
	PERSISTENT_AGENT_NAME,
	type NormalizedManagedAgentOutputs,
	type PluginRunSessionsOptions,
	SETTING_MANAGED_AGENT_CONFIG_HASH,
	SETTING_MANAGED_AGENT_ID,
	SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH,
	SETTING_MANAGED_ENVIRONMENT_ID,
	WORKSPACE_SEED_MANIFEST_MOUNT_PATH
} from './types.js';
import { createCmaSdkClient, resolveUserScopedSettings } from './utils/cma-sdk.js';
import { ensureControlPlane } from './utils/control-plane.js';
import { runManagedSessions } from './utils/fan-out.js';
import { cleanupManagedAgentRun } from './utils/managed-agents-cleanup.js';
import { AnthropicManagedAgentsClient } from './utils/managed-agents-client.js';
import {
	buildCancelledResult,
	buildErrorResult,
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
	buildVariantSessionPrompt,
	buildWorkspaceSeedPrompt
} from './utils/prompt-builder.js';
import { extractAgentTranscript, normalizeOutputs, parseStructuredOutput } from './utils/result-parser.js';
import { captureScreenshots } from './utils/screenshot-capture.js';
import { buildManagedAgentMetrics } from './utils/usage-metrics.js';
import { buildWorkspaceSeedManifest } from './utils/workspace-seed.js';

// Security: runtime bounds for `target_items`, mirroring the form-level
// validation in form-schema.ts (validateFormInput enforces 1..250). Kept local
// to this file so the runtime cap in getTargetItems() is enforced even when the
// request bypasses the UI/form validation path.
const MIN_TARGET_ITEMS = 1;
const MAX_TARGET_ITEMS = 250;

const MANIFEST: PluginManifest = {
	id: 'claude-managed-agent',
	name: 'Claude Managed Agent',
	version: '1.0.0',
	description: 'Full pipeline plugin that delegates work generation to Anthropic Claude Managed Agents',
	category: 'pipeline',
	capabilities: ['pipeline', 'form-schema-provider'],
	author: { name: 'Ever Works Team' },
	license: 'AGPL-3.0',
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
			},
			reuseControlPlane: {
				type: 'boolean',
				title: 'Reuse Control Plane',
				description:
					'Keep one persistent managed agent and environment per user and only create sessions per run (recommended). Disable to fall back to creating and deleting the agent and environment on every run.',
				default: true,
				'x-scope': 'global'
			},
			// feat-cma-scale — plugin-managed persistent control-plane state.
			// Hidden: written by the plugin via context.updateSettings at user
			// scope, never edited by users.
			[SETTING_MANAGED_AGENT_ID]: {
				type: 'string',
				title: 'Managed Agent ID',
				'x-hidden': true,
				'x-scope': 'user'
			},
			[SETTING_MANAGED_AGENT_CONFIG_HASH]: {
				type: 'string',
				title: 'Managed Agent Config Hash',
				'x-hidden': true,
				'x-scope': 'user'
			},
			[SETTING_MANAGED_ENVIRONMENT_ID]: {
				type: 'string',
				title: 'Managed Environment ID',
				'x-hidden': true,
				'x-scope': 'user'
			},
			[SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH]: {
				type: 'string',
				title: 'Managed Environment Config Hash',
				'x-hidden': true,
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	private context: PluginContext | null = null;
	private state: PipelineState<ClaudeManagedAgentStepId> | null = null;
	private abortController: AbortController | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.registerFanOutCapability(context);
		context.logger.log('Claude Managed Agent plugin loaded');
	}

	/**
	 * Publish the fan-out service on the platform's custom capability registry
	 * so API-side services and Trigger.dev tasks can call it without resolving
	 * the plugin instance themselves.
	 *
	 * Guarded on every axis because a failure here must never stop the plugin
	 * from loading: hosts may hand over a partial context (the capability
	 * methods are optional in practice even though the interface requires
	 * them), and the registry THROWS on a duplicate name — which happens when
	 * a plugin is re-loaded before its previous registration is torn down.
	 */
	private registerFanOutCapability(context: PluginContext): void {
		if (typeof context.registerCustomCapability !== 'function') {
			return;
		}

		if (context.hasCustomCapability?.(CMA_FAN_OUT_CAPABILITY)) {
			return;
		}

		const implementation: ManagedAgentFanOutCapability = {
			runSessions: (options) => this.runSessions(options)
		};

		try {
			context.registerCustomCapability(
				{
					name: CMA_FAN_OUT_CAPABILITY,
					description: 'Run N Claude Managed Agent sessions in parallel with bounded concurrency.',
					version: this.version,
					methods: ['runSessions']
				},
				implementation
			);
		} catch (error) {
			context.logger.warn(
				`Claude Managed Agent: fan-out capability not registered: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
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

	/**
	 * feat-cma-scale — fan-out service: spawn N parallel Claude Managed Agent
	 * sessions from one call. Exposed on the plugin instance so API-side code
	 * (and Trigger.dev tasks holding a plugin reference) can reach it without
	 * going through the pipeline. Uses the persistent control plane when
	 * `reuseControlPlane` is enabled; otherwise creates an ephemeral agent +
	 * environment for the batch and tears them down afterwards.
	 */
	async runSessions(options: PluginRunSessionsOptions): Promise<ManagedSessionRunResult[]> {
		if (!options.userId) {
			throw new Error('runSessions requires a userId for settings resolution.');
		}

		if (!Array.isArray(options.prompts) || options.prompts.length === 0) {
			return [];
		}

		const logger = this.context?.logger ?? console;
		const settings = options.workId
			? await resolveManagedAgentSettings(this.context, options.userId, options.workId)
			: await resolveUserScopedSettings(this.context, options.userId);
		const client = createCmaSdkClient(settings);
		const model = (settings.model as string | undefined) || DEFAULT_MODEL;

		const controlPlane = await ensureControlPlane(
			client,
			this.context,
			options.userId,
			settings,
			{
				name: PERSISTENT_AGENT_NAME,
				description: 'Persistent Ever Works managed generation agent',
				model,
				system: buildSystemPrompt()
			},
			null,
			logger
		);

		try {
			return await runManagedSessions(client, {
				prompts: options.prompts,
				agentId: controlPlane.agentId,
				environmentId: controlPlane.environmentId,
				concurrency: options.concurrency,
				// The programmatic entry point bypasses the generation form, so
				// the budget ceiling is re-applied here rather than trusting the
				// caller — a runaway value would otherwise fan out unbounded spend.
				perSessionBudgetUsd: clampPerSessionBudgetUsd(options.perSessionBudgetUsd),
				timeoutMs: options.timeoutMs,
				resources: options.resources,
				pollIntervalMs: getNumericSetting(settings.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
				maxPollAttempts: getNumericSetting(settings.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS),
				agentOverrides: { model },
				signal: options.signal,
				logger
			});
		} finally {
			if (controlPlane.ephemeral) {
				await cleanupManagedAgentRun(
					client,
					{
						createdAgentId: controlPlane.agentId,
						createdEnvironmentId: controlPlane.environmentId
					},
					{ warn: (message) => logger.warn(message) }
				);
			}
		}
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
		const variantSessions = this.getVariantSessions(config);
		const perSessionBudgetUsd = this.getPerSessionBudgetUsd(config);
		const shouldCaptureScreenshots = config.capture_screenshots !== false;
		let client: AnthropicManagedAgentsClient | null = null;
		let preserveControlPlane = false;
		const runResources: ManagedAgentRunResources = {};

		try {
			await this.beginStep('configure-managed-agent', onProgress, 5);

			const settings = await resolveManagedAgentSettings(this.context, userId, work.id);
			client = createCmaSdkClient(settings);
			const model = (settings.model as string | undefined) || DEFAULT_MODEL;
			const reuseControlPlane = settings.reuseControlPlane !== false;
			preserveControlPlane = reuseControlPlane;
			// Memory upgrades M3 — session preamble splice. The block
			// arrives pre-fenced (`<agent_memory>…</agent_memory>`) +
			// neutralized from the platform's shared recall helper; append
			// verbatim. Absent = nothing to splice (provider off / toggle
			// off / older orchestrator).
			const baseSystemPrompt = buildSystemPrompt();
			const systemPrompt = execContext.memoryRecall
				? `${baseSystemPrompt}\n\n${execContext.memoryRecall}`
				: baseSystemPrompt;
			const workspaceSeedManifest = buildWorkspaceSeedManifest(DEFAULT_WORKSPACE_PATH, work, request, existing);
			const uploadedSeedManifest = await client.uploadTextFile(
				'ever-works-workspace-seed.json',
				JSON.stringify(workspaceSeedManifest, null, 2)
			);
			runResources.uploadedFileId = uploadedSeedManifest.id;

			let agentId: string;
			let environmentId: string;
			// Per-session overrides (reuse mode only): the persistent agent
			// carries the base system prompt; the run's model and any memory
			// recall ride on the session so agent versions never churn per run.
			let sessionAgentOverrides: { system?: string; model?: string } | undefined;

			if (reuseControlPlane) {
				const runtimeEnvironment = this.getRuntimeEnvironment(execContext);
				const controlPlane = await ensureControlPlane(
					client,
					this.context,
					userId,
					settings,
					{
						name: PERSISTENT_AGENT_NAME,
						description: 'Persistent Ever Works managed generation agent',
						model,
						system: baseSystemPrompt
					},
					runtimeEnvironment,
					logger
				);
				agentId = controlPlane.agentId;
				environmentId = controlPlane.environmentId;
				sessionAgentOverrides = execContext.memoryRecall ? { model, system: systemPrompt } : { model };
			} else {
				agentId = (
					await client.createAgent({
						name: `Ever Works Agent: ${work.slug}`,
						description: `Managed Ever Works generation agent for ${work.slug}`,
						model,
						system: systemPrompt
					})
				).id;
				runResources.createdAgentId = agentId;

				environmentId = (
					await client.createEnvironment({
						name: `Ever Works Environment: ${work.slug}`
					})
				).id;
				runResources.createdEnvironmentId = environmentId;
			}

			this.completeStep('configure-managed-agent');

			if (abortController.signal.aborted) {
				return this.toCancelledResult(startTime).result;
			}

			if (variantSessions > 1) {
				return await this.executeVariantSessions({
					client,
					work,
					request,
					existing,
					settings,
					execContext,
					abortController,
					onProgress,
					startTime,
					targetItems,
					variantSessions,
					perSessionBudgetUsd,
					shouldCaptureScreenshots,
					agentId,
					environmentId,
					sessionAgentOverrides,
					uploadedSeedFileId: uploadedSeedManifest.id,
					workspaceSeedManifest,
					logger,
					userId
				});
			}

			this.skipStep('run-variant-sessions');

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
				],
				budgetUsd: perSessionBudgetUsd,
				agentOverrides: sessionAgentOverrides
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
					? buildManagedAgentMetrics({
							startTime,
							duration: Date.now() - startTime,
							itemCount: normalizedOutputs.items.length,
							sessions: [
								{
									id: 'session-1',
									status: 'completed',
									sessionId: session.id,
									tokens: {
										inputTokens: finalSession.usage.input_tokens ?? 0,
										outputTokens: finalSession.usage.output_tokens ?? 0,
										totalTokens:
											(finalSession.usage.input_tokens ?? 0) +
											(finalSession.usage.output_tokens ?? 0)
									},
									costUsd: finalSession.usage.list_cost_usd
								}
							]
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
				await cleanupManagedAgentRun(
					client,
					runResources,
					{
						warn: (message) => logger.warn(message)
					},
					{ preserveControlPlane }
				);
			}
			this.abortController = null;
		}
	}

	/**
	 * Variants path (feat-cma-scale): fan out N parallel sessions, each
	 * bootstrapping its own workspace and producing an independent result
	 * set; per-session transcripts are parsed and merged with de-duplication.
	 * A failed sibling never aborts the batch — only an all-failed batch
	 * fails the run.
	 */
	private async executeVariantSessions(input: {
		client: AnthropicManagedAgentsClient;
		work: WorkReference;
		request: GenerationRequest;
		existing: ExistingItems;
		settings: Record<string, unknown>;
		execContext: NonNullable<PipelineExecutionOptions['execContext']>;
		abortController: AbortController;
		onProgress: PipelineProgressCallback | undefined;
		startTime: number;
		targetItems: number;
		variantSessions: number;
		perSessionBudgetUsd: number | undefined;
		shouldCaptureScreenshots: boolean;
		agentId: string;
		environmentId: string;
		sessionAgentOverrides: { system?: string; model?: string } | undefined;
		uploadedSeedFileId: string;
		workspaceSeedManifest: ReturnType<typeof buildWorkspaceSeedManifest>;
		logger: { log(m: string): void; warn(m: string): void; error(m: string): void };
		userId: string;
	}): Promise<PipelineResult> {
		const {
			client,
			work,
			request,
			existing,
			settings,
			execContext,
			abortController,
			onProgress,
			startTime,
			targetItems,
			variantSessions,
			perSessionBudgetUsd,
			shouldCaptureScreenshots,
			agentId,
			environmentId,
			sessionAgentOverrides,
			uploadedSeedFileId,
			workspaceSeedManifest,
			logger,
			userId
		} = input;

		this.skipStep('run-managed-session');
		await this.beginStep('run-variant-sessions', onProgress, 20);

		const prompts = Array.from({ length: variantSessions }, (_, index) => ({
			id: `variant-${index + 1}`,
			title: `Ever Works: ${work.name} (variant ${index + 1}/${variantSessions})`,
			prompt: buildVariantSessionPrompt({
				manifest: workspaceSeedManifest,
				work,
				request,
				existing,
				targetItems,
				variantIndex: index,
				variantCount: variantSessions
			})
		}));

		const sessionResults = await runManagedSessions(client, {
			prompts,
			agentId,
			environmentId,
			perSessionBudgetUsd,
			resources: [
				{
					type: 'file',
					file_id: uploadedSeedFileId,
					mount_path: WORKSPACE_SEED_MANIFEST_MOUNT_PATH
				}
			],
			pollIntervalMs: getNumericSetting(settings.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
			maxPollAttempts: getNumericSetting(settings.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS),
			agentOverrides: sessionAgentOverrides,
			signal: abortController.signal,
			logger
		});

		this.completeStep('run-variant-sessions');

		if (abortController.signal.aborted) {
			return this.toCancelledResult(startTime).result;
		}

		await this.beginStep('parse-agent-output', onProgress, 80);

		const warnings: string[] = [];
		const parsedOutputs: NormalizedManagedAgentOutputs[] = [];

		for (const result of sessionResults) {
			if (result.status !== 'completed' || !result.output) {
				warnings.push(`Variant session ${result.id} ${result.status}: ${result.error ?? 'no output'}`);
				continue;
			}

			try {
				const structured = parseStructuredOutput(result.output);
				warnings.push(...(structured.warnings || []).map((warning) => `[${result.id}] ${warning}`));
				parsedOutputs.push(normalizeOutputs(structured));
			} catch (parseError) {
				warnings.push(
					`Variant session ${result.id} returned an unparsable result: ${
						parseError instanceof Error ? parseError.message : String(parseError)
					}`
				);
			}
		}

		if (parsedOutputs.length === 0) {
			throw new Error(
				`All ${variantSessions} variant sessions failed. First failure: ${
					sessionResults.find((r) => r.status !== 'completed')?.error ?? 'unknown error'
				}`
			);
		}

		const normalizedOutputs = this.mergeVariantOutputs(parsedOutputs);

		this.completeStep('parse-agent-output');

		if (abortController.signal.aborted) {
			return this.toCancelledResult(startTime, normalizedOutputs).result;
		}

		if (shouldCaptureScreenshots && execContext.screenshotFacade?.isAvailable()) {
			await this.beginStep('capture-screenshots', onProgress, 92);

			const screenshotWarnings = await captureScreenshots(
				normalizedOutputs.items,
				execContext.screenshotFacade,
				{ userId, workId: work.id },
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
			metrics: buildManagedAgentMetrics({
				startTime,
				duration: Date.now() - startTime,
				itemCount: normalizedOutputs.items.length,
				sessions: sessionResults
			}),
			warnings
		});
	}

	/** Merge variant outputs, de-duplicating items and taxonomy entries. */
	private mergeVariantOutputs(outputs: NormalizedManagedAgentOutputs[]): NormalizedManagedAgentOutputs {
		if (outputs.length === 1) {
			return outputs[0];
		}

		const itemMap = new Map<string, NormalizedManagedAgentOutputs['items'][number]>();
		const categoryMap = new Map<string, NormalizedManagedAgentOutputs['categories'][number]>();
		const tagMap = new Map<string, NormalizedManagedAgentOutputs['tags'][number]>();
		const collectionMap = new Map<string, NormalizedManagedAgentOutputs['collections'][number]>();
		const brandMap = new Map<string, NormalizedManagedAgentOutputs['brands'][number]>();
		const operations = {
			created_files: [] as string[],
			updated_files: [] as string[],
			unchanged_seeded_files_count: 0
		};
		let hasOperations = false;

		for (const output of outputs) {
			for (const item of output.items) {
				// Items are the same when both the name and the source URL
				// match (case-insensitive) — first variant wins.
				const key = `${item.name.toLowerCase()}::${(item.source_url || '').toLowerCase()}`;
				if (!itemMap.has(key)) {
					itemMap.set(key, item);
				}
			}

			for (const category of output.categories) {
				if (!categoryMap.has(category.id)) {
					categoryMap.set(category.id, category);
				}
			}

			for (const tag of output.tags) {
				if (!tagMap.has(tag.id)) {
					tagMap.set(tag.id, tag);
				}
			}

			for (const collection of output.collections) {
				if (!collectionMap.has(collection.id)) {
					collectionMap.set(collection.id, collection);
				}
			}

			for (const brand of output.brands) {
				if (!brandMap.has(brand.id)) {
					brandMap.set(brand.id, brand);
				}
			}

			const ops = output.extra?.operations;
			if (ops) {
				hasOperations = true;
				operations.created_files.push(...(ops.created_files ?? []));
				operations.updated_files.push(...(ops.updated_files ?? []));
				operations.unchanged_seeded_files_count = Math.max(
					operations.unchanged_seeded_files_count,
					ops.unchanged_seeded_files_count ?? 0
				);
			}
		}

		return {
			items: [...itemMap.values()],
			categories: [...categoryMap.values()],
			tags: [...tagMap.values()],
			collections: [...collectionMap.values()],
			brands: [...brandMap.values()],
			extra: hasOperations
				? {
						operations: {
							created_files: [...new Set(operations.created_files)],
							updated_files: [...new Set(operations.updated_files)],
							unchanged_seeded_files_count: operations.unchanged_seeded_files_count
						}
					}
				: undefined
		};
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
			// Security: re-apply the form-level 1..250 bound (form-schema.ts
			// validateFormInput) at runtime. `config.target_items` reaches
			// execute() straight from the GenerationRequest, so an authenticated
			// caller hitting the API directly bypasses UI validation and could
			// pass e.g. 50000 — which gets embedded verbatim into the agent's
			// user prompt ("Target items: 50000") and drives unbounded research,
			// runtime, and Anthropic credit consumption. Clamp instead of
			// rejecting so all legitimate (already in-range) inputs are unchanged.
			return Math.max(MIN_TARGET_ITEMS, Math.min(MAX_TARGET_ITEMS, Math.floor(value)));
		}

		return DEFAULT_TARGET_ITEMS;
	}

	private getVariantSessions(config: Record<string, unknown>): number {
		const value = config.variant_sessions;
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			// Security: same runtime clamp rationale as getTargetItems — each
			// variant is a full managed-agent session, so an out-of-range value
			// reaching execute() directly must not fan out unbounded spend.
			return Math.max(MIN_VARIANT_SESSIONS, Math.min(MAX_VARIANT_SESSIONS, Math.floor(value)));
		}

		return MIN_VARIANT_SESSIONS;
	}

	private getPerSessionBudgetUsd(config: Record<string, unknown>): number | undefined {
		return clampPerSessionBudgetUsd(config.per_session_budget_usd);
	}

	/**
	 * Optional serializable runtime-environment object carried on the
	 * pipeline execution context by the platform's Environments feature
	 * (parallel branch). Read defensively — absent or malformed values fall
	 * back to the env-var driven networking policy.
	 */
	private getRuntimeEnvironment(execContext: unknown): ManagedRuntimeEnvironment | null {
		if (!execContext || typeof execContext !== 'object') {
			return null;
		}

		const candidate = (execContext as Record<string, unknown>).runtimeEnvironment;
		if (!candidate || typeof candidate !== 'object') {
			return null;
		}

		return candidate as ManagedRuntimeEnvironment;
	}
}

export type { ClaudeManagedAgentStepId } from './types.js';

export default ClaudeManagedAgentPlugin;
