import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    ExecutablePipeline,
    PipelineState,
    StepState,
    StepStatus,
    StepMetrics,
    PipelineStepDefinition,
} from '@ever-works/plugin';

/**
 * Pipeline runtime events
 */
export const PipelineRuntimeEvents = {
    STATE_CHANGED: 'pipeline:state-changed',
    STEP_STATUS_CHANGED: 'pipeline:step-status-changed',
} as const;

/**
 * State change event payload
 */
export interface StateChangePayload {
    stepId: string;
    previousStatus: StepStatus;
    newStatus: StepStatus;
    timestamp: number;
}

/**
 * Runtime wrapper for ExecutablePipeline that manages execution state.
 *
 * This class wraps the compiled ExecutablePipeline interface with runtime state management,
 * allowing tracking of step progress, completion status, and metrics during execution.
 */
export class ExecutablePipelineRunner {
    /**
     * The current pipeline state
     */
    private state: PipelineState;

    /**
     * Step states indexed by step ID for fast lookup
     */
    private stepStates: Map<string, StepState>;

    /**
     * When the pipeline execution started
     */
    private executionStartTime?: number;

    constructor(
        private readonly pipeline: ExecutablePipeline,
        private readonly eventEmitter?: EventEmitter2,
    ) {
        this.stepStates = new Map();
        this.state = this.createInitialState();
    }

    /**
     * Create the initial pipeline state with all steps pending
     */
    private createInitialState(): PipelineState {
        const steps = new Map<string, StepState>();

        for (const step of this.pipeline.steps) {
            const stepState: StepState = {
                definition: step,
                status: 'pending',
            };
            steps.set(step.id, stepState);
            this.stepStates.set(step.id, stepState);
        }

        return {
            steps,
            completedSteps: [],
            failedSteps: [],
            isRunning: false,
            isCancelled: false,
        };
    }

    /**
     * Get the compiled pipeline
     */
    getPipeline(): ExecutablePipeline {
        return this.pipeline;
    }

    /**
     * Get the current pipeline state
     */
    getState(): PipelineState {
        return this.state;
    }

    /**
     * Get a specific step's state
     */
    getStepState(stepId: string): StepState | undefined {
        return this.stepStates.get(stepId);
    }

    /**
     * Get the step definition for a step ID
     */
    getStepDefinition(stepId: string): PipelineStepDefinition | undefined {
        return this.pipeline.steps.find((s) => s.id === stepId);
    }

    /**
     * Get the current running step ID
     */
    getCurrentStep(): string | undefined {
        return this.state.currentStep;
    }

    /**
     * Check if the pipeline is running
     */
    isRunning(): boolean {
        return this.state.isRunning;
    }

    /**
     * Check if the pipeline was cancelled
     */
    isCancelled(): boolean {
        return this.state.isCancelled;
    }

    /**
     * Start the pipeline execution
     */
    startExecution(): void {
        this.executionStartTime = Date.now();
        this.state = {
            ...this.state,
            isRunning: true,
            startedAt: this.executionStartTime,
        };
    }

    /**
     * Mark the pipeline execution as complete
     */
    completeExecution(): void {
        this.state = {
            ...this.state,
            isRunning: false,
            completedAt: Date.now(),
        };
    }

    /**
     * Mark the pipeline as cancelled
     */
    cancelExecution(): void {
        this.state = {
            ...this.state,
            isRunning: false,
            isCancelled: true,
            completedAt: Date.now(),
        };
    }

    /**
     * Update a step's status
     */
    updateStepStatus(stepId: string, status: StepStatus): void {
        const stepState = this.stepStates.get(stepId);
        if (!stepState) {
            throw new Error(`Step "${stepId}" not found in pipeline`);
        }

        const previousStatus = stepState.status;
        const now = Date.now();

        // Create updated step state
        const updatedState: StepState = {
            ...stepState,
            status,
            ...(status === 'running' && { startedAt: now }),
            ...(status === 'completed' && { completedAt: now }),
            ...(status === 'failed' && { completedAt: now }),
            ...(status === 'skipped' && { completedAt: now }),
        };

        // Update in map
        this.stepStates.set(stepId, updatedState);
        this.state.steps.set(stepId, updatedState);

        // Update current step tracking
        if (status === 'running') {
            this.state = {
                ...this.state,
                currentStep: stepId,
            };
        } else if (this.state.currentStep === stepId) {
            this.state = {
                ...this.state,
                currentStep: undefined,
            };
        }

        // Emit state change event
        if (this.eventEmitter) {
            this.eventEmitter.emit(PipelineRuntimeEvents.STEP_STATUS_CHANGED, {
                stepId,
                previousStatus,
                newStatus: status,
                timestamp: now,
            } as StateChangePayload);
        }
    }

    /**
     * Mark a step as starting
     */
    startStep(stepId: string): void {
        this.updateStepStatus(stepId, 'running');
    }

    /**
     * Mark a step as complete with metrics
     */
    markStepComplete(stepId: string, metrics?: StepMetrics): void {
        const stepState = this.stepStates.get(stepId);
        if (!stepState) {
            throw new Error(`Step "${stepId}" not found in pipeline`);
        }

        const now = Date.now();
        const updatedState: StepState = {
            ...stepState,
            status: 'completed',
            completedAt: now,
            result: metrics ? { metrics } : undefined,
        };

        this.stepStates.set(stepId, updatedState);
        this.state.steps.set(stepId, updatedState);

        // Add to completed steps list
        this.state = {
            ...this.state,
            currentStep: undefined,
            completedSteps: [...this.state.completedSteps, stepId],
        };

        if (this.eventEmitter) {
            this.eventEmitter.emit(PipelineRuntimeEvents.STEP_STATUS_CHANGED, {
                stepId,
                previousStatus: 'running',
                newStatus: 'completed',
                timestamp: now,
            } as StateChangePayload);
        }
    }

    /**
     * Mark a step as failed
     */
    markStepFailed(stepId: string, error: Error): void {
        const stepState = this.stepStates.get(stepId);
        if (!stepState) {
            throw new Error(`Step "${stepId}" not found in pipeline`);
        }

        const now = Date.now();
        const updatedState: StepState = {
            ...stepState,
            status: 'failed',
            completedAt: now,
            error,
        };

        this.stepStates.set(stepId, updatedState);
        this.state.steps.set(stepId, updatedState);

        // Add to failed steps list
        this.state = {
            ...this.state,
            currentStep: undefined,
            failedSteps: [...this.state.failedSteps, stepId],
        };

        if (this.eventEmitter) {
            this.eventEmitter.emit(PipelineRuntimeEvents.STEP_STATUS_CHANGED, {
                stepId,
                previousStatus: 'running',
                newStatus: 'failed',
                timestamp: now,
            } as StateChangePayload);
        }
    }

    /**
     * Mark a step as skipped
     */
    markStepSkipped(stepId: string, reason?: string): void {
        const stepState = this.stepStates.get(stepId);
        if (!stepState) {
            throw new Error(`Step "${stepId}" not found in pipeline`);
        }

        const now = Date.now();
        const updatedState: StepState = {
            ...stepState,
            status: 'skipped',
            completedAt: now,
            result: reason ? { skipReason: reason } : undefined,
        };

        this.stepStates.set(stepId, updatedState);
        this.state.steps.set(stepId, updatedState);

        // Add to completed steps list (skipped is still "done")
        this.state = {
            ...this.state,
            completedSteps: [...this.state.completedSteps, stepId],
        };

        if (this.eventEmitter) {
            this.eventEmitter.emit(PipelineRuntimeEvents.STEP_STATUS_CHANGED, {
                stepId,
                previousStatus: 'pending',
                newStatus: 'skipped',
                timestamp: now,
            } as StateChangePayload);
        }
    }

    /**
     * Get progress information
     */
    getProgress(): {
        completed: number;
        total: number;
        failed: number;
        skipped: number;
        percent: number;
    } {
        const total = this.pipeline.steps.length;
        const completed = this.state.completedSteps.length;
        const failed = this.state.failedSteps.length;
        const skipped = Array.from(this.stepStates.values()).filter(
            (s) => s.status === 'skipped',
        ).length;

        return {
            completed,
            total,
            failed,
            skipped,
            percent: total > 0 ? Math.round((completed / total) * 100) : 0,
        };
    }

    /**
     * Get step metrics summary
     */
    getMetricsSummary(): {
        totalDuration: number;
        stepDurations: Map<string, number>;
        averageStepDuration: number;
    } {
        const stepDurations = new Map<string, number>();
        let totalDuration = 0;

        for (const [stepId, stepState] of this.stepStates) {
            if (stepState.startedAt && stepState.completedAt) {
                const duration = stepState.completedAt - stepState.startedAt;
                stepDurations.set(stepId, duration);
                totalDuration += duration;
            }
        }

        const completedCount = stepDurations.size;
        const averageStepDuration = completedCount > 0 ? totalDuration / completedCount : 0;

        return {
            totalDuration,
            stepDurations,
            averageStepDuration,
        };
    }

    /**
     * Get steps that are ready to execute (all dependencies satisfied)
     */
    getReadySteps(): PipelineStepDefinition[] {
        const completedSet = new Set(this.state.completedSteps);
        const ready: PipelineStepDefinition[] = [];

        for (const step of this.pipeline.steps) {
            const stepState = this.stepStates.get(step.id);
            if (!stepState || stepState.status !== 'pending') {
                continue;
            }

            // Check if all required dependencies are complete
            const depsComplete =
                !step.dependencies ||
                step.dependencies.every((dep) => !dep.required || completedSet.has(dep.stepId));

            if (depsComplete) {
                ready.push(step);
            }
        }

        return ready;
    }

    /**
     * Check if all steps are complete (or skipped/failed if allowed)
     */
    isComplete(): boolean {
        const progress = this.getProgress();
        return progress.completed + progress.failed === progress.total;
    }

    /**
     * Check if pipeline can continue (has ready steps and not cancelled)
     */
    canContinue(): boolean {
        if (this.state.isCancelled) {
            return false;
        }

        return this.getReadySteps().length > 0;
    }

    /**
     * Get the next step to execute (first ready step)
     */
    getNextStep(): PipelineStepDefinition | undefined {
        const ready = this.getReadySteps();
        return ready.length > 0 ? ready[0] : undefined;
    }

    /**
     * Reset the pipeline state (for re-execution)
     */
    reset(): void {
        this.stepStates.clear();
        this.state = this.createInitialState();
        this.executionStartTime = undefined;
    }
}
