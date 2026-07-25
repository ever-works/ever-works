import type {
	ExistingItems,
	FormFieldDefinition,
	FormFieldGroup,
	GenerationRequest,
	IBuiltInStepExecutor,
	IFormSchemaProvider,
	IPipelineContext,
	IPipelinePlugin,
	JsonSchema,
	PipelineExecutionOptions,
	PipelineProgressCallback,
	PipelineResult,
	PipelineState,
	PipelineStepDefinition,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	StepExecutionContext,
	StepExecutionOptions,
	StepProgressCallback,
	ValidationResult,
	WorkReference
} from '@ever-works/plugin';
import { GtmPipelineContext, type GtmContextSnapshot } from './context.js';
import type { GtmStageDataKey, GtmStageId } from './types.js';
import { getGtmFormFields, getGtmFormGroups, GTM_DEFAULT_SETTINGS, validateGtmFormInput } from './settings.js';
import { ResearchStep } from './steps/research.step.js';
import { QualifyStep } from './steps/qualify.step.js';
import { DraftStep } from './steps/draft.step.js';
import { ReviewStep } from './steps/review.step.js';
import { ActStep } from './steps/act.step.js';
import { FollowUpStep } from './steps/follow-up.step.js';
import { EnrichStep } from './steps/enrich.step.js';
import { MeasureStep } from './steps/measure.step.js';

/**
 * Go-to-Market Pipeline Plugin.
 *
 * Engine-orchestratable pipeline with the go-to-market stage set:
 * research → qualify → draft → review → act → follow-up → enrich → measure.
 *
 * Every stage declares its input/output keys (`requires`/`provides`) so
 * stage handoffs are explicit and auditable. The `review` stage is the
 * human gate placed BEFORE any outbound action; the `act` stage stages
 * approved drafts for delivery but never sends (drafts-not-sends).
 */
export class GtmPipelinePlugin implements IPipelinePlugin<GtmStageId>, IFormSchemaProvider {
	private static readonly STAGES: PipelineStepDefinition<GtmStageId>[] = [
		{
			id: 'research',
			name: 'Research',
			description: 'Collects seed contacts and fresh market signals for the campaign',
			position: { type: 'first' },
			dependencies: [],
			provides: ['contacts', 'signals'],
			requires: [],
			optional: false,
			parallelizable: false,
			estimatedDuration: 20
		},
		{
			id: 'qualify',
			name: 'Qualify',
			description: 'Deterministic-first scoring and risk filtering of collected contacts',
			position: { type: 'after', stepId: 'research' },
			dependencies: [{ stepId: 'research', required: true }],
			provides: ['scored_contacts'],
			requires: ['contacts'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 5
		},
		{
			id: 'draft',
			name: 'Draft',
			description: 'Personalized content drafting for the configured channels and tone',
			position: { type: 'after', stepId: 'qualify' },
			dependencies: [{ stepId: 'qualify', required: true }],
			provides: ['drafts'],
			requires: ['scored_contacts'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 30
		},
		{
			id: 'review',
			name: 'Review',
			description: 'Human gate before any outbound action — pauses until drafts are approved',
			position: { type: 'after', stepId: 'draft' },
			dependencies: [{ stepId: 'draft', required: true }],
			provides: ['approved_drafts'],
			requires: ['drafts'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 2
		},
		{
			id: 'act',
			name: 'Act',
			description: 'Stages approved drafts for delivery (never sends directly)',
			position: { type: 'after', stepId: 'review' },
			dependencies: [{ stepId: 'review', required: true }],
			provides: ['action_log'],
			requires: ['approved_drafts'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 5
		},
		{
			id: 'follow-up',
			name: 'Follow-up',
			description: 'Queues timed re-engagement for prepared actions gone quiet',
			position: { type: 'after', stepId: 'act' },
			dependencies: [{ stepId: 'act', required: true }],
			provides: ['follow_up_queue'],
			requires: ['action_log'],
			optional: true,
			parallelizable: false,
			estimatedDuration: 2
		},
		{
			id: 'enrich',
			name: 'Enrich',
			description: 'Evidence-bound backfill of missing contact fields from collected signals',
			position: { type: 'after', stepId: 'follow-up' },
			dependencies: [{ stepId: 'research', required: true }],
			provides: ['enriched_contacts'],
			requires: ['contacts'],
			optional: true,
			parallelizable: true,
			estimatedDuration: 15
		},
		{
			id: 'measure',
			name: 'Measure',
			description: 'Compiles the campaign report and next-variant hints (closes the loop)',
			position: { type: 'last' },
			dependencies: [{ stepId: 'act', required: true }],
			provides: ['campaign_report'],
			requires: ['action_log'],
			optional: false,
			parallelizable: false,
			estimatedDuration: 10
		}
	];

	private static readonly STAGES_MAP: Map<GtmStageId, PipelineStepDefinition<GtmStageId>> = new Map(
		GtmPipelinePlugin.STAGES.map((stage) => [stage.id, stage])
	);

	// IPlugin properties
	readonly id = 'gtm-pipeline';
	readonly name = 'Go-to-Market Pipeline';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities: readonly string[] = ['pipeline', 'form-schema-provider'];
	readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };
	readonly handledConfigFields = ['*'] as const;

	private stepExecutors = new Map<GtmStageId, IBuiltInStepExecutor>();
	private context?: PluginContext;

	// IPipelinePlugin methods
	registerStepExecutor(stepId: GtmStageId, executor: IBuiltInStepExecutor): void {
		this.stepExecutors.set(stepId, executor);
	}

	isValidStepId(stepId: string): stepId is GtmStageId {
		return GtmPipelinePlugin.STAGES_MAP.has(stepId as GtmStageId);
	}

	getStepDefinition(stepId?: GtmStageId | string): PipelineStepDefinition<GtmStageId> | undefined {
		if (stepId) {
			return GtmPipelinePlugin.STAGES_MAP.get(stepId as GtmStageId);
		}
		return GtmPipelinePlugin.STAGES[0];
	}

	getStepDefinitions(): PipelineStepDefinition<GtmStageId>[] {
		return [...GtmPipelinePlugin.STAGES];
	}

	async execute(
		_work: WorkReference,
		_request: GenerationRequest,
		_existing: ExistingItems,
		_options?: PipelineExecutionOptions,
		_onProgress?: PipelineProgressCallback
	): Promise<PipelineResult> {
		// GTM pipeline is engine-orchestrated — the engine calls executeStep()
		// for each stage individually (and honors the review gate's shouldStop).
		throw new Error(
			'GtmPipelinePlugin.execute() should not be called directly. ' +
				'Use the pipeline engine to orchestrate stage execution.'
		);
	}

	async executeStep(
		stepId: GtmStageId | string,
		context: IPipelineContext,
		execContext: StepExecutionContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<IPipelineContext> {
		const executor = this.stepExecutors.get(stepId as GtmStageId);
		if (!executor) {
			throw new Error(`No executor registered for stage "${stepId}"`);
		}

		if (onProgress) {
			onProgress({ percent: 0, message: `Starting ${executor.name}` });
		}
		if (options?.signal?.aborted) {
			throw new Error(`Stage "${stepId}" was cancelled before execution`);
		}

		try {
			const result = await executor.run(context, execContext);
			if (onProgress) {
				onProgress({ percent: 100, message: `Completed ${executor.name}` });
			}
			return result;
		} catch (error) {
			this.context?.logger.error(`Stage "${stepId}" failed: ${(error as Error).message}`);
			throw error;
		}
	}

	// --- Context lifecycle hooks ---

	createContext(work: WorkReference, request: GenerationRequest, _existing: ExistingItems): IPipelineContext {
		return new GtmPipelineContext(work, request);
	}

	contextToSnapshot(context: IPipelineContext): unknown {
		return (context as GtmPipelineContext).toSnapshot();
	}

	contextFromSnapshot(snapshot: unknown): IPipelineContext {
		return GtmPipelineContext.fromSnapshot(snapshot as GtmContextSnapshot);
	}

	extractResult(
		context: IPipelineContext,
		meta: { duration: number; stepsCompleted: number; totalSteps: number; state?: PipelineState }
	): PipelineResult {
		const ctx = context as GtmPipelineContext;
		return {
			// A run paused at the review gate is a successful (resumable)
			// run, not a failure — pending_review travels in outputs.extra.
			success: true,
			outputs: ctx.toPipelineOutputs(),
			duration: meta.duration,
			stepsCompleted: meta.stepsCompleted,
			totalSteps: meta.totalSteps,
			state: meta.state,
			warnings: ctx.warnings
		};
	}

	/**
	 * A checkpoint is viable when the run paused at the review gate
	 * (resume happens once approvals arrive) or any stage data exists.
	 */
	isCheckpointViable(snapshot: unknown, completedSteps: string[]): boolean {
		const ctx = snapshot as GtmContextSnapshot;
		if (ctx.pendingReview) return true;
		if (ctx.shouldStop) return false;
		const hasData =
			(ctx.contacts?.length ?? 0) > 0 ||
			(ctx.signals?.length ?? 0) > 0 ||
			(ctx.drafts?.length ?? 0) > 0 ||
			(ctx.actionLog?.length ?? 0) > 0;
		if (hasData) return true;
		// If data-producing stages already ran but produced nothing, restart.
		const dataStages: string[] = ['research', 'draft', 'act'];
		return !completedSteps.some((id) => dataStages.includes(id));
	}

	canSkipStep(stepId: string, context: IPipelineContext): boolean {
		const ctx = context as GtmPipelineContext;
		const stage = this.getStepDefinition(stepId as GtmStageId);
		if (!stage?.provides?.length) return false;
		return stage.provides.every((key) => ctx.hasStageResult(key as GtmStageDataKey));
	}

	// IFormSchemaProvider methods
	getFormFields(): FormFieldDefinition[] {
		return getGtmFormFields();
	}

	getFormGroups(): FormFieldGroup[] {
		return getGtmFormGroups();
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		return validateGtmFormInput(values);
	}

	getDefaultValues(): Record<string, unknown> {
		const defaults: Record<string, unknown> = {};
		for (const field of this.getFormFields()) {
			if (field.defaultValue !== undefined) {
				defaults[field.name] = field.defaultValue;
			}
		}
		return defaults;
	}

	transformFormValues(values: Record<string, unknown>): Record<string, unknown> {
		const transformed = { ...values };
		for (const key of Object.keys(transformed)) {
			if (Array.isArray(transformed[key]) && (transformed[key] as unknown[]).length === 0) {
				delete transformed[key];
			}
		}
		return transformed;
	}

	// IPlugin lifecycle

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.registerBuiltInStepExecutors();
		context.logger.log(`Go-to-Market Pipeline Plugin loaded with ${this.stepExecutors.size} stage executors`);
	}

	private registerBuiltInStepExecutors(): void {
		const stepExecutors: Record<GtmStageId, IBuiltInStepExecutor> = {
			research: new ResearchStep(),
			qualify: new QualifyStep(),
			draft: new DraftStep(),
			review: new ReviewStep(),
			act: new ActStep(),
			'follow-up': new FollowUpStep(),
			enrich: new EnrichStep(),
			measure: new MeasureStep()
		};
		for (const [stepId, executor] of Object.entries(stepExecutors)) {
			this.registerStepExecutor(stepId as GtmStageId, executor);
		}
	}

	async onUnload(): Promise<void> {
		this.stepExecutors.clear();
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const registeredSteps = this.stepExecutors.size;
		const totalSteps = GtmPipelinePlugin.STAGES.length;
		const allRegistered = registeredSteps === totalSteps;
		const missingSteps = GtmPipelinePlugin.STAGES.filter((s) => !this.stepExecutors.has(s.id)).map((s) => s.id);

		return {
			status: allRegistered ? 'healthy' : 'degraded',
			message: allRegistered
				? `All ${totalSteps} GTM stages registered`
				: `Only ${registeredSteps}/${totalSteps} stages registered`,
			checkedAt: Date.now(),
			checks: missingSteps.map((stepId) => ({
				name: `stage-${stepId}`,
				status: 'unhealthy' as const,
				message: `Missing executor for stage: ${stepId}`,
				data: { stepId }
			}))
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Go-to-market pipeline with research, qualify, draft, review, act, follow-up, enrich, and measure stages',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			selectableProviderCategories: ['ai-provider', 'search'],
			readme: [
				'## What is the Go-to-Market Pipeline?',
				'',
				'An engine-orchestrated pipeline for go-to-market campaigns. It runs 8 stages — research, qualify, draft, review, act, follow-up, enrich, and measure — with explicit input/output keys declared per stage so every handoff is auditable.',
				'',
				'## Stages',
				'',
				'1. **Research** — normalizes seed contacts and collects fresh market signals via web search',
				'2. **Qualify** — deterministic-first scoring (declarative weight table) plus risk filtering',
				'3. **Draft** — personalized 80-120 word drafts per contact per channel, in the configured tone',
				'4. **Review** — the human gate: pauses before ANY outbound action until drafts are approved',
				'5. **Act** — stages approved drafts for delivery; never sends directly (drafts-not-sends)',
				'6. **Follow-up** — queues timed re-engagement for prepared actions gone quiet',
				'7. **Enrich** — evidence-bound backfill of missing contact fields from collected signals',
				'8. **Measure** — compiles the campaign report with next-variant hints, closing the loop into the next draft cycle',
				'',
				'## Settings',
				'',
				'- **Target channels** — where content is prepared for (email, blog, social, newsletter, community)',
				'- **Tone** — voice used for drafted content',
				'- **Cadence** — expected run frequency, also used by follow-up rationale',
				'- **Qualification knobs** — minimum score, risk exclusion threshold, max contacts per run',
				'- **Review** — required by default; disabling it is recorded in the run warnings',
				'',
				'## Safety posture',
				'',
				'- Contacts come only from explicit seed lists — the pipeline never fabricates people',
				'- The review gate pauses the run (resumable checkpoint) until approvals arrive',
				'- The act stage records prepared actions for connectors/humans to deliver — it never sends'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>'
			}
		};
	}
}

export default GtmPipelinePlugin;
