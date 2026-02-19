/**
 * Configurable mock pipeline plugin for testing pipeline services.
 *
 * Steps are configured per-test via setSteps(). No hardcoded defaults.
 * This avoids coupling tests to any specific pipeline implementation and
 * lets each test define exactly the step graph it needs.
 */
import { Injectable } from '@nestjs/common';
import type {
    IPipelinePlugin,
    IBuiltInStepExecutor,
    PipelineStepDefinition,
    PipelineExecutionOptions,
    PipelineProgressCallback,
    PipelineResult,
    StepExecutionOptions,
    StepProgressCallback,
    IPipelineContext,
    StepExecutionContext,
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    PluginCategory,
    JsonSchema,
    PipelineState,
} from '@ever-works/plugin';
import { createEmptyPipelineOutputs } from '@ever-works/plugin';

/**
 * Simple mock pipeline context for tests.
 * Stores step data in a generic record rather than typed fields.
 */
class MockPipelineContext implements IPipelineContext {
    directory: DirectoryReference;
    request: GenerationRequest;
    existing: ExistingItems;
    shouldStop?: boolean;
    warnings: string[] = [];

    /** Generic data storage for step provides/requires */
    data: Record<string, unknown> = {};

    constructor(
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
    ) {
        this.directory = directory;
        this.request = request;
        this.existing = existing;
    }
}

/**
 * Injectable mock pipeline plugin used in pipeline service tests.
 * Call setSteps() in your beforeEach to configure the pipeline graph.
 */
@Injectable()
export class MockPipelinePlugin implements IPipelinePlugin<string> {
    readonly id = 'standard-pipeline';
    readonly name = 'Standard Pipeline';
    readonly version = '1.0.0';
    readonly category: PluginCategory = 'pipeline';
    readonly capabilities: readonly string[] = ['pipeline'];
    readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };

    private steps: PipelineStepDefinition[] = [];
    private stepExecutors = new Map<string, IBuiltInStepExecutor>();

    /** Configure the steps this pipeline provides. Call in beforeEach(). */
    setSteps(steps: PipelineStepDefinition[]): void {
        this.steps = steps;
        this.stepExecutors.clear();
    }

    // --- IPipelinePlugin required methods ---

    getStepDefinitions(): PipelineStepDefinition[] {
        return [...this.steps];
    }

    async execute(
        _directory: DirectoryReference,
        _request: GenerationRequest,
        _existing: ExistingItems,
        _options?: PipelineExecutionOptions,
        _onProgress?: PipelineProgressCallback,
    ): Promise<PipelineResult> {
        throw new Error(
            'MockPipelinePlugin.execute() should not be called directly. ' +
                'Use the pipeline engine to orchestrate step execution.',
        );
    }

    // --- Optional: engine-orchestrated step execution ---

    registerStepExecutor(stepId: string, executor: IBuiltInStepExecutor): void {
        this.stepExecutors.set(stepId, executor);
    }

    isValidStepId(stepId: string): stepId is string {
        return this.steps.some((s) => s.id === stepId);
    }

    async executeStep(
        stepId: string,
        context: IPipelineContext,
        _execContext: StepExecutionContext,
        options?: StepExecutionOptions,
        onProgress?: StepProgressCallback,
    ): Promise<IPipelineContext> {
        const executor = this.stepExecutors.get(stepId);
        if (!executor) {
            throw new Error(`No executor registered for step "${stepId}"`);
        }

        if (onProgress) {
            onProgress({ percent: 0, message: `Starting ${executor.name}` });
        }

        if (options?.signal?.aborted) {
            throw new Error(`Step "${stepId}" was cancelled before execution`);
        }

        const result = await executor.run(context, _execContext);
        if (onProgress) {
            onProgress({ percent: 100, message: `Completed ${executor.name}` });
        }
        return result;
    }

    // --- Lifecycle hooks for engine-orchestrated execution ---

    createContext(
        directory: DirectoryReference,
        request: GenerationRequest,
        existing: ExistingItems,
    ): IPipelineContext {
        return new MockPipelineContext(directory, request, existing);
    }

    contextToSnapshot(context: IPipelineContext): unknown {
        return { ...context };
    }

    contextFromSnapshot(snapshot: unknown): IPipelineContext {
        const s = snapshot as any;
        const ctx = new MockPipelineContext(s.directory, s.request, s.existing);
        ctx.shouldStop = s.shouldStop;
        ctx.warnings = s.warnings ?? [];
        ctx.data = s.data ?? {};
        return ctx;
    }

    extractResult(
        context: IPipelineContext,
        meta: {
            duration: number;
            stepsCompleted: number;
            totalSteps: number;
            state?: PipelineState;
        },
    ): PipelineResult {
        return {
            success: true,
            outputs: createEmptyPipelineOutputs(),
            duration: meta.duration,
            stepsCompleted: meta.stepsCompleted,
            totalSteps: meta.totalSteps,
            state: meta.state,
            warnings: context.warnings.length > 0 ? context.warnings : undefined,
            error: undefined,
        };
    }

    isCheckpointViable(_snapshot: unknown, _completedSteps: string[]): boolean {
        return true;
    }

    canSkipStep(_stepId: string, _context: IPipelineContext): boolean {
        return false;
    }

    // --- Lifecycle stubs ---

    async onLoad(): Promise<void> {}
    async onUnload(): Promise<void> {}
    async validateSettings(): Promise<{ valid: boolean }> {
        return { valid: true };
    }
    getState(): PipelineState | null {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Helpers – build step definitions for common test patterns
// ---------------------------------------------------------------------------

/** Create a linear chain of steps from a list of IDs. */
export function createLinearChain(
    ids: string[],
    options?: { parallelizable?: Set<string>; estimatedDuration?: number },
): PipelineStepDefinition[] {
    const dur = options?.estimatedDuration ?? 5;
    return ids.map((id, i) => ({
        id,
        name: id
            .split('-')
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join(' '),
        description: `Mock step: ${id}`,
        position:
            i === 0
                ? ({ type: 'first' } as const)
                : i === ids.length - 1
                  ? ({ type: 'last' } as const)
                  : ({ type: 'after', stepId: ids[i - 1] } as const),
        dependencies: i === 0 ? [] : [{ stepId: ids[i - 1], required: true }],
        provides: [`${id}-data`],
        requires: i === 0 ? [] : [`${ids[i - 1]}-data`],
        optional: false,
        parallelizable: options?.parallelizable?.has(id) ?? false,
        estimatedDuration: dur,
    }));
}
