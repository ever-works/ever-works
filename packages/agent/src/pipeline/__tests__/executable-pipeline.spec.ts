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
});
