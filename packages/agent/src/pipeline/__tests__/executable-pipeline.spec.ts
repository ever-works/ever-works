import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExecutablePipelineRunner, PipelineRuntimeEvents } from '../executable-pipeline.class';
import type { ExecutablePipeline, PipelineStepDefinition, StepMetrics } from '@ever-works/plugin';

describe('ExecutablePipelineRunner', () => {
    let runner: ExecutablePipelineRunner;
    let eventEmitter: EventEmitter2;
    let mockPipeline: ExecutablePipeline;

    const createMockStep = (
        id: string,
        name: string,
        options: Partial<PipelineStepDefinition> = {},
    ): PipelineStepDefinition => ({
        id,
        name,
        position: { type: 'last' },
        ...options,
    });

    const createMockPipeline = (steps: PipelineStepDefinition[]): ExecutablePipeline => ({
        steps,
        groups: [{ id: 'group-1', stepIds: steps.map((s) => s.id), allRequired: true }],
        executorMap: new Map(steps.map((s) => [s.id, { type: 'builtin', serviceId: s.id }])),
        replacedSteps: new Map(),
        disabledSteps: new Set(),
        injectedSteps: new Set(),
        source: 'standard',
    });

    beforeEach(() => {
        eventEmitter = {
            emit: jest.fn(),
            on: jest.fn(),
            off: jest.fn(),
        } as unknown as EventEmitter2;

        mockPipeline = createMockPipeline([
            createMockStep('step-1', 'Step 1'),
            createMockStep('step-2', 'Step 2', {
                dependencies: [{ stepId: 'step-1', required: true }],
            }),
            createMockStep('step-3', 'Step 3', {
                dependencies: [{ stepId: 'step-2', required: true }],
            }),
        ]);

        runner = new ExecutablePipelineRunner(mockPipeline, eventEmitter);
    });

    describe('constructor', () => {
        it('should initialize with pipeline', () => {
            expect(runner.getPipeline()).toBe(mockPipeline);
        });

        it('should create initial state with all steps pending', () => {
            const state = runner.getState();

            expect(state.isRunning).toBe(false);
            expect(state.isCancelled).toBe(false);
            expect(state.completedSteps).toHaveLength(0);
            expect(state.failedSteps).toHaveLength(0);

            for (const step of mockPipeline.steps) {
                const stepState = state.steps.get(step.id);
                expect(stepState).toBeDefined();
                expect(stepState?.status).toBe('pending');
            }
        });

        it('should work without event emitter', () => {
            const runnerNoEvents = new ExecutablePipelineRunner(mockPipeline);
            expect(runnerNoEvents.getState()).toBeDefined();
        });
    });

    describe('getStepState()', () => {
        it('should return step state for valid step ID', () => {
            const stepState = runner.getStepState('step-1');

            expect(stepState).toBeDefined();
            expect(stepState?.definition.id).toBe('step-1');
            expect(stepState?.status).toBe('pending');
        });

        it('should return undefined for invalid step ID', () => {
            const stepState = runner.getStepState('invalid-step');
            expect(stepState).toBeUndefined();
        });
    });

    describe('getStepDefinition()', () => {
        it('should return step definition for valid step ID', () => {
            const definition = runner.getStepDefinition('step-1');

            expect(definition).toBeDefined();
            expect(definition?.id).toBe('step-1');
            expect(definition?.name).toBe('Step 1');
        });

        it('should return undefined for invalid step ID', () => {
            const definition = runner.getStepDefinition('invalid-step');
            expect(definition).toBeUndefined();
        });
    });

    describe('startExecution()', () => {
        it('should mark pipeline as running', () => {
            runner.startExecution();

            expect(runner.isRunning()).toBe(true);
            expect(runner.getState().startedAt).toBeDefined();
        });
    });

    describe('completeExecution()', () => {
        it('should mark pipeline as not running', () => {
            runner.startExecution();
            runner.completeExecution();

            expect(runner.isRunning()).toBe(false);
            expect(runner.getState().completedAt).toBeDefined();
        });
    });

    describe('cancelExecution()', () => {
        it('should mark pipeline as cancelled', () => {
            runner.startExecution();
            runner.cancelExecution();

            expect(runner.isRunning()).toBe(false);
            expect(runner.isCancelled()).toBe(true);
            expect(runner.getState().completedAt).toBeDefined();
        });
    });

    describe('updateStepStatus()', () => {
        it('should update step status to running', () => {
            runner.updateStepStatus('step-1', 'running');

            const stepState = runner.getStepState('step-1');
            expect(stepState?.status).toBe('running');
            expect(stepState?.startedAt).toBeDefined();
        });

        it('should update step status to completed', () => {
            runner.updateStepStatus('step-1', 'running');
            runner.updateStepStatus('step-1', 'completed');

            const stepState = runner.getStepState('step-1');
            expect(stepState?.status).toBe('completed');
            expect(stepState?.completedAt).toBeDefined();
        });

        it('should throw for invalid step ID', () => {
            expect(() => runner.updateStepStatus('invalid-step', 'running')).toThrow(
                'Step "invalid-step" not found in pipeline',
            );
        });

        it('should emit status change event', () => {
            runner.updateStepStatus('step-1', 'running');

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineRuntimeEvents.STEP_STATUS_CHANGED,
                expect.objectContaining({
                    stepId: 'step-1',
                    previousStatus: 'pending',
                    newStatus: 'running',
                }),
            );
        });

        it('should track current step when running', () => {
            runner.updateStepStatus('step-1', 'running');

            expect(runner.getCurrentStep()).toBe('step-1');
        });

        it('should clear current step when completed', () => {
            runner.updateStepStatus('step-1', 'running');
            runner.updateStepStatus('step-1', 'completed');

            expect(runner.getCurrentStep()).toBeUndefined();
        });
    });

    describe('startStep()', () => {
        it('should mark step as running', () => {
            runner.startStep('step-1');

            expect(runner.getStepState('step-1')?.status).toBe('running');
            expect(runner.getCurrentStep()).toBe('step-1');
        });
    });

    describe('markStepComplete()', () => {
        it('should mark step as completed', () => {
            runner.startStep('step-1');
            runner.markStepComplete('step-1');

            expect(runner.getStepState('step-1')?.status).toBe('completed');
            expect(runner.getState().completedSteps).toContain('step-1');
        });

        it('should store metrics when provided', () => {
            const metrics: StepMetrics = {
                name: 'Step 1',
                startTime: Date.now(),
                duration: 1000,
                success: true,
            };

            runner.startStep('step-1');
            runner.markStepComplete('step-1', metrics);

            const stepState = runner.getStepState('step-1');
            expect(stepState?.result).toEqual({ metrics });
        });

        it('should emit status change event', () => {
            runner.startStep('step-1');
            runner.markStepComplete('step-1');

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineRuntimeEvents.STEP_STATUS_CHANGED,
                expect.objectContaining({
                    stepId: 'step-1',
                    newStatus: 'completed',
                }),
            );
        });

        it('should throw for invalid step ID', () => {
            expect(() => runner.markStepComplete('invalid-step')).toThrow(
                'Step "invalid-step" not found in pipeline',
            );
        });
    });

    describe('markStepFailed()', () => {
        it('should mark step as failed', () => {
            const error = new Error('Test error');
            runner.startStep('step-1');
            runner.markStepFailed('step-1', error);

            expect(runner.getStepState('step-1')?.status).toBe('failed');
            expect(runner.getStepState('step-1')?.error).toBe(error);
            expect(runner.getState().failedSteps).toContain('step-1');
        });

        it('should emit status change event', () => {
            runner.startStep('step-1');
            runner.markStepFailed('step-1', new Error('Test'));

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineRuntimeEvents.STEP_STATUS_CHANGED,
                expect.objectContaining({
                    stepId: 'step-1',
                    newStatus: 'failed',
                }),
            );
        });

        it('should throw for invalid step ID', () => {
            expect(() => runner.markStepFailed('invalid-step', new Error('Test'))).toThrow(
                'Step "invalid-step" not found in pipeline',
            );
        });
    });

    describe('markStepSkipped()', () => {
        it('should mark step as skipped', () => {
            runner.markStepSkipped('step-1', 'data already provided');

            expect(runner.getStepState('step-1')?.status).toBe('skipped');
            expect(runner.getState().completedSteps).toContain('step-1');
        });

        it('should store skip reason', () => {
            runner.markStepSkipped('step-1', 'data already provided');

            const stepState = runner.getStepState('step-1');
            expect(stepState?.result).toEqual({ skipReason: 'data already provided' });
        });

        it('should emit status change event', () => {
            runner.markStepSkipped('step-1');

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineRuntimeEvents.STEP_STATUS_CHANGED,
                expect.objectContaining({
                    stepId: 'step-1',
                    newStatus: 'skipped',
                }),
            );
        });

        it('should throw for invalid step ID', () => {
            expect(() => runner.markStepSkipped('invalid-step')).toThrow(
                'Step "invalid-step" not found in pipeline',
            );
        });
    });

    describe('getProgress()', () => {
        it('should return initial progress', () => {
            const progress = runner.getProgress();

            expect(progress.completed).toBe(0);
            expect(progress.total).toBe(3);
            expect(progress.failed).toBe(0);
            expect(progress.skipped).toBe(0);
            expect(progress.percent).toBe(0);
        });

        it('should update progress as steps complete', () => {
            runner.markStepComplete('step-1');

            const progress = runner.getProgress();
            expect(progress.completed).toBe(1);
            expect(progress.percent).toBe(33);
        });

        it('should track failed steps', () => {
            runner.markStepFailed('step-1', new Error('Test'));

            const progress = runner.getProgress();
            expect(progress.failed).toBe(1);
        });

        it('should track skipped steps', () => {
            runner.markStepSkipped('step-1');

            const progress = runner.getProgress();
            expect(progress.skipped).toBe(1);
            expect(progress.completed).toBe(1); // Skipped counts as completed
        });
    });

    describe('getMetricsSummary()', () => {
        it('should return empty metrics initially', () => {
            const summary = runner.getMetricsSummary();

            expect(summary.totalDuration).toBe(0);
            expect(summary.stepDurations.size).toBe(0);
            expect(summary.averageStepDuration).toBe(0);
        });

        it('should calculate metrics for completed steps', () => {
            // Manually set step times to calculate duration
            runner.startStep('step-1');
            // Simulate time passing
            const stepState = runner.getStepState('step-1')!;
            (stepState as any).startedAt = Date.now() - 1000;
            runner.markStepComplete('step-1');

            const summary = runner.getMetricsSummary();
            expect(summary.stepDurations.size).toBe(1);
            expect(summary.totalDuration).toBeGreaterThan(0);
        });
    });

    describe('getReadySteps()', () => {
        it('should return steps with no dependencies initially', () => {
            const ready = runner.getReadySteps();

            // Only step-1 has no dependencies
            expect(ready).toHaveLength(1);
            expect(ready[0].id).toBe('step-1');
        });

        it('should return dependent steps after dependencies complete', () => {
            runner.markStepComplete('step-1');

            const ready = runner.getReadySteps();

            // step-2 should now be ready
            expect(ready).toHaveLength(1);
            expect(ready[0].id).toBe('step-2');
        });

        it('should return multiple ready steps when available', () => {
            // Create pipeline with parallel steps
            const parallelPipeline = createMockPipeline([
                createMockStep('step-a', 'Step A'),
                createMockStep('step-b', 'Step B'),
                createMockStep('step-c', 'Step C', {
                    dependencies: [
                        { stepId: 'step-a', required: true },
                        { stepId: 'step-b', required: true },
                    ],
                }),
            ]);

            const parallelRunner = new ExecutablePipelineRunner(parallelPipeline);
            const ready = parallelRunner.getReadySteps();

            expect(ready).toHaveLength(2);
            expect(ready.map((s) => s.id)).toContain('step-a');
            expect(ready.map((s) => s.id)).toContain('step-b');
        });

        it('should not return completed steps', () => {
            runner.markStepComplete('step-1');

            const ready = runner.getReadySteps();

            expect(ready.find((s) => s.id === 'step-1')).toBeUndefined();
        });

        it('should not return running steps', () => {
            runner.startStep('step-1');

            const ready = runner.getReadySteps();

            expect(ready.find((s) => s.id === 'step-1')).toBeUndefined();
        });
    });

    describe('isComplete()', () => {
        it('should return false when steps are pending', () => {
            expect(runner.isComplete()).toBe(false);
        });

        it('should return true when all steps complete', () => {
            runner.markStepComplete('step-1');
            runner.markStepComplete('step-2');
            runner.markStepComplete('step-3');

            expect(runner.isComplete()).toBe(true);
        });

        it('should return true when all steps complete or failed', () => {
            runner.markStepComplete('step-1');
            runner.markStepFailed('step-2', new Error('Test'));
            runner.markStepComplete('step-3');

            expect(runner.isComplete()).toBe(true);
        });
    });

    describe('canContinue()', () => {
        it('should return true when ready steps available', () => {
            expect(runner.canContinue()).toBe(true);
        });

        it('should return false when cancelled', () => {
            runner.cancelExecution();

            expect(runner.canContinue()).toBe(false);
        });

        it('should return false when no ready steps', () => {
            // Mark step-1 as running but not complete
            runner.startStep('step-1');

            // step-2 depends on step-1, so nothing is ready
            expect(runner.canContinue()).toBe(false);
        });
    });

    describe('getNextStep()', () => {
        it('should return first ready step', () => {
            const next = runner.getNextStep();

            expect(next).toBeDefined();
            expect(next?.id).toBe('step-1');
        });

        it('should return undefined when no steps ready', () => {
            runner.startStep('step-1');

            const next = runner.getNextStep();

            expect(next).toBeUndefined();
        });
    });

    describe('reset()', () => {
        it('should reset all state', () => {
            runner.startExecution();
            runner.markStepComplete('step-1');
            runner.markStepFailed('step-2', new Error('Test'));

            runner.reset();

            const state = runner.getState();
            expect(state.isRunning).toBe(false);
            expect(state.completedSteps).toHaveLength(0);
            expect(state.failedSteps).toHaveLength(0);

            for (const step of mockPipeline.steps) {
                expect(runner.getStepState(step.id)?.status).toBe('pending');
            }
        });
    });
});
