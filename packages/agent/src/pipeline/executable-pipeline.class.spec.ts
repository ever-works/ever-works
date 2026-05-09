import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ExecutablePipeline, PipelineStepDefinition } from '@ever-works/plugin';
import {
    ExecutablePipelineRunner,
    PipelineRuntimeEvents,
    type StateChangePayload,
} from './executable-pipeline.class';

function makeStep(
    id: string,
    overrides: Partial<PipelineStepDefinition> = {},
): PipelineStepDefinition {
    return {
        id,
        name: `Step ${id}`,
        position: { type: 'after', stepId: '__start__' } as never,
        ...overrides,
    } as PipelineStepDefinition;
}

function makePipeline(stepIds: string[] = ['s1', 's2', 's3']): ExecutablePipeline {
    return {
        steps: stepIds.map((id) => makeStep(id)),
    } as ExecutablePipeline;
}

describe('ExecutablePipelineRunner', () => {
    let pipeline: ExecutablePipeline;
    let runner: ExecutablePipelineRunner;
    let emitter: EventEmitter2;
    let emitSpy: jest.SpyInstance;

    beforeEach(() => {
        pipeline = makePipeline();
        emitter = new EventEmitter2();
        emitSpy = jest.spyOn(emitter, 'emit');
        runner = new ExecutablePipelineRunner(pipeline, emitter);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('PipelineRuntimeEvents barrel', () => {
        it('pins literal event names (wire format)', () => {
            // The two literal strings are emitted on the EventEmitter2 bus and consumed
            // by callers outside this package — changing these strings is a wire-format
            // break and must be deliberate.
            expect(PipelineRuntimeEvents.STATE_CHANGED).toBe('pipeline:state-changed');
            expect(PipelineRuntimeEvents.STEP_STATUS_CHANGED).toBe('pipeline:step-status-changed');
        });

        it('STATE_CHANGED is exported but NEVER emitted by this class (declared-but-unused gotcha)', () => {
            // Pinned so a future "wire up state-change events" feature is deliberate.
            // Today: only STEP_STATUS_CHANGED fires; STATE_CHANGED is reserved.
            const r = new ExecutablePipelineRunner(makePipeline(['only-step']), emitter);
            r.startExecution();
            r.startStep('only-step');
            r.markStepComplete('only-step');
            r.completeExecution();

            const events = emitSpy.mock.calls.map((c) => c[0]);
            expect(events).not.toContain(PipelineRuntimeEvents.STATE_CHANGED);
            expect(events.every((e) => e === PipelineRuntimeEvents.STEP_STATUS_CHANGED)).toBe(true);
        });
    });

    describe('constructor / initial state', () => {
        it('initialises with all steps in pending status and empty step lists', () => {
            const state = runner.getState();
            expect(state.isRunning).toBe(false);
            expect(state.isCancelled).toBe(false);
            expect(state.completedSteps).toEqual([]);
            expect(state.failedSteps).toEqual([]);
            expect(state.currentStep).toBeUndefined();
            expect(state.startedAt).toBeUndefined();
            expect(state.completedAt).toBeUndefined();
            expect(state.steps.size).toBe(3);
            for (const stepId of ['s1', 's2', 's3']) {
                const stepState = state.steps.get(stepId);
                expect(stepState?.status).toBe('pending');
                expect(stepState?.definition.id).toBe(stepId);
            }
        });

        it('preserves the original pipeline reference (no clone)', () => {
            expect(runner.getPipeline()).toBe(pipeline);
        });

        it('handles a pipeline with zero steps without throwing', () => {
            const empty = new ExecutablePipelineRunner(makePipeline([]));
            const state = empty.getState();
            expect(state.steps.size).toBe(0);
            expect(state.completedSteps).toEqual([]);
            expect(state.failedSteps).toEqual([]);
        });

        it('handles a pipeline with duplicate step IDs by collapsing into the LAST definition (Map.set semantics)', () => {
            // Pinned: the constructor uses Map.set keyed by step.id; if two definitions
            // share an id the second one wins. This is documented behaviour rather
            // than a bug — but worth pinning so a future "throw on duplicate id"
            // refactor breaks loudly.
            const dup = new ExecutablePipelineRunner({
                steps: [makeStep('s1', { name: 'first' }), makeStep('s1', { name: 'second' })],
            } as ExecutablePipeline);
            expect(dup.getState().steps.size).toBe(1);
            expect(dup.getState().steps.get('s1')?.definition.name).toBe('second');
        });

        it('does not throw when constructed without an EventEmitter (optional dep)', () => {
            const noEmitter = new ExecutablePipelineRunner(pipeline);
            expect(() => {
                noEmitter.startExecution();
                noEmitter.startStep('s1');
                noEmitter.markStepComplete('s1');
                noEmitter.completeExecution();
            }).not.toThrow();
        });
    });

    describe('getStepState / getStepDefinition / getCurrentStep', () => {
        it('getStepState returns the stored state for a known step', () => {
            const stepState = runner.getStepState('s1');
            expect(stepState?.status).toBe('pending');
        });

        it('getStepState returns undefined for an unknown step id', () => {
            expect(runner.getStepState('does-not-exist')).toBeUndefined();
        });

        it('getStepDefinition uses Array.find on pipeline.steps (NOT the internal Map)', () => {
            // Pinned: the implementation goes through pipeline.steps with .find rather
            // than reading the internal stepStates map. If pipeline.steps mutates after
            // construction, getStepDefinition reflects the mutation but getStepState
            // does not. Useful invariant for caller code.
            expect(runner.getStepDefinition('s2')?.id).toBe('s2');
            expect(runner.getStepDefinition('does-not-exist')).toBeUndefined();
        });

        it('getCurrentStep returns undefined initially and after pipeline completion', () => {
            expect(runner.getCurrentStep()).toBeUndefined();
            runner.startExecution();
            runner.startStep('s1');
            expect(runner.getCurrentStep()).toBe('s1');
            runner.markStepComplete('s1');
            expect(runner.getCurrentStep()).toBeUndefined();
        });
    });

    describe('isRunning / isCancelled', () => {
        it('reflect state.isRunning / state.isCancelled accurately across the lifecycle', () => {
            expect(runner.isRunning()).toBe(false);
            expect(runner.isCancelled()).toBe(false);

            runner.startExecution();
            expect(runner.isRunning()).toBe(true);
            expect(runner.isCancelled()).toBe(false);

            runner.cancelExecution();
            expect(runner.isRunning()).toBe(false);
            expect(runner.isCancelled()).toBe(true);
        });

        it('completeExecution does NOT set isCancelled', () => {
            runner.startExecution();
            runner.completeExecution();
            expect(runner.isRunning()).toBe(false);
            expect(runner.isCancelled()).toBe(false);
        });
    });

    describe('startExecution', () => {
        it('records executionStartTime on state.startedAt and sets isRunning=true', () => {
            const before = Date.now();
            runner.startExecution();
            const after = Date.now();
            const state = runner.getState();
            expect(state.isRunning).toBe(true);
            expect(state.startedAt).toBeGreaterThanOrEqual(before);
            expect(state.startedAt).toBeLessThanOrEqual(after);
        });

        it('does NOT clear completedSteps / failedSteps if called twice (no-op idempotency NOT guaranteed)', () => {
            // Pinned: startExecution is destructive on the top-level fields it touches
            // but PRESERVES completedSteps / failedSteps via the spread. A future
            // "reset on start" refactor must update this test deliberately.
            runner.startExecution();
            runner.startStep('s1');
            runner.markStepComplete('s1');
            const before = runner.getState().completedSteps.slice();

            runner.startExecution();
            const state = runner.getState();
            expect(state.completedSteps).toEqual(before);
            expect(state.isRunning).toBe(true);
        });
    });

    describe('completeExecution', () => {
        it('sets isRunning=false and stamps completedAt', () => {
            runner.startExecution();
            const beforeStop = Date.now();
            runner.completeExecution();
            const afterStop = Date.now();
            const state = runner.getState();
            expect(state.isRunning).toBe(false);
            expect(state.completedAt).toBeGreaterThanOrEqual(beforeStop);
            expect(state.completedAt).toBeLessThanOrEqual(afterStop);
        });

        it('preserves startedAt when completing (audit trail)', () => {
            runner.startExecution();
            const startedAt = runner.getState().startedAt;
            runner.completeExecution();
            expect(runner.getState().startedAt).toBe(startedAt);
        });
    });

    describe('cancelExecution', () => {
        it('sets isRunning=false, isCancelled=true, AND stamps completedAt', () => {
            runner.startExecution();
            runner.cancelExecution();
            const state = runner.getState();
            expect(state.isRunning).toBe(false);
            expect(state.isCancelled).toBe(true);
            expect(state.completedAt).toBeDefined();
        });
    });

    describe('updateStepStatus', () => {
        it('throws verbatim "Step \\"<id>\\" not found in pipeline" for unknown step', () => {
            expect(() => runner.updateStepStatus('nope', 'running')).toThrow(
                'Step "nope" not found in pipeline',
            );
        });

        it('sets startedAt only on running status', () => {
            runner.updateStepStatus('s1', 'running');
            const state = runner.getStepState('s1')!;
            expect(state.status).toBe('running');
            expect(state.startedAt).toBeDefined();
            expect(state.completedAt).toBeUndefined();
        });

        it('sets completedAt on completed/failed/skipped (NOT pending or running)', () => {
            const ids = ['s1', 's2', 's3'] as const;
            const statuses = ['completed', 'failed', 'skipped'] as const;
            for (let i = 0; i < ids.length; i++) {
                runner.updateStepStatus(ids[i], statuses[i]);
                expect(runner.getStepState(ids[i])?.completedAt).toBeDefined();
            }
            // 'pending' is untouched (default already)
            const r = new ExecutablePipelineRunner(makePipeline(['p1']), emitter);
            r.updateStepStatus('p1', 'pending');
            expect(r.getStepState('p1')?.completedAt).toBeUndefined();
            expect(r.getStepState('p1')?.startedAt).toBeUndefined();
        });

        it('updates currentStep when status===running and clears it on any other transition that matches the current step', () => {
            runner.updateStepStatus('s1', 'running');
            expect(runner.getCurrentStep()).toBe('s1');
            runner.updateStepStatus('s1', 'completed');
            expect(runner.getCurrentStep()).toBeUndefined();
        });

        it('does NOT clear currentStep when transitioning a DIFFERENT step (parallel-step safety)', () => {
            runner.updateStepStatus('s1', 'running');
            runner.updateStepStatus('s2', 'completed');
            expect(runner.getCurrentStep()).toBe('s1');
        });

        it('emits STEP_STATUS_CHANGED with the documented payload shape', () => {
            const before = Date.now();
            runner.updateStepStatus('s1', 'running');
            const after = Date.now();
            expect(emitSpy).toHaveBeenCalledWith(
                PipelineRuntimeEvents.STEP_STATUS_CHANGED,
                expect.objectContaining({
                    stepId: 's1',
                    previousStatus: 'pending',
                    newStatus: 'running',
                }),
            );
            const payload = emitSpy.mock.calls[0][1] as StateChangePayload;
            expect(payload.timestamp).toBeGreaterThanOrEqual(before);
            expect(payload.timestamp).toBeLessThanOrEqual(after);
        });

        it('previousStatus reflects the state BEFORE the update (not the new status)', () => {
            runner.updateStepStatus('s1', 'running');
            emitSpy.mockClear();
            runner.updateStepStatus('s1', 'completed');
            const payload = emitSpy.mock.calls[0][1] as StateChangePayload;
            expect(payload.previousStatus).toBe('running');
            expect(payload.newStatus).toBe('completed');
        });

        it('does NOT emit when constructed without an EventEmitter', () => {
            const noEmitter = new ExecutablePipelineRunner(pipeline);
            expect(() => noEmitter.updateStepStatus('s1', 'running')).not.toThrow();
            // Spy on EventEmitter prototype emit to confirm it was not invoked.
            const protoSpy = jest.spyOn(EventEmitter2.prototype, 'emit');
            noEmitter.updateStepStatus('s1', 'completed');
            expect(protoSpy).not.toHaveBeenCalled();
            protoSpy.mockRestore();
        });
    });

    describe('startStep convenience', () => {
        it('delegates to updateStepStatus with status=running', () => {
            const spy = jest.spyOn(runner, 'updateStepStatus');
            runner.startStep('s1');
            expect(spy).toHaveBeenCalledWith('s1', 'running');
        });
    });

    describe('markStepComplete', () => {
        it('throws verbatim error for unknown step', () => {
            expect(() => runner.markStepComplete('nope')).toThrow(
                'Step "nope" not found in pipeline',
            );
        });

        it('sets status=completed, stamps completedAt, appends to completedSteps, clears currentStep', () => {
            runner.startStep('s1');
            const before = Date.now();
            runner.markStepComplete('s1');
            const after = Date.now();
            const state = runner.getState();
            const stepState = state.steps.get('s1')!;
            expect(stepState.status).toBe('completed');
            expect(stepState.completedAt).toBeGreaterThanOrEqual(before);
            expect(stepState.completedAt).toBeLessThanOrEqual(after);
            expect(state.completedSteps).toEqual(['s1']);
            expect(state.currentStep).toBeUndefined();
        });

        it('attaches metrics under result.metrics (only when metrics provided)', () => {
            runner.markStepComplete('s1', { tokensUsed: 100, latencyMs: 250 } as never);
            expect(runner.getStepState('s1')?.result).toEqual({
                metrics: { tokensUsed: 100, latencyMs: 250 },
            });
        });

        it('omits result when metrics===undefined (does NOT set {metrics: undefined})', () => {
            runner.markStepComplete('s1');
            expect(runner.getStepState('s1')?.result).toBeUndefined();
        });

        it('appends in chronological order across multiple completions (preserves order)', () => {
            runner.markStepComplete('s2');
            runner.markStepComplete('s1');
            runner.markStepComplete('s3');
            expect(runner.getState().completedSteps).toEqual(['s2', 's1', 's3']);
        });

        it('emits STEP_STATUS_CHANGED with previousStatus="running" (HARDCODED, NOT read from state)', () => {
            // Pinned: markStepComplete emits previousStatus:'running' as a literal,
            // even if the step was actually pending. Same pattern in markStepFailed.
            // A future "compute previousStatus from state" refactor must be deliberate.
            runner.markStepComplete('s1');
            const payload = emitSpy.mock.calls[0][1] as StateChangePayload;
            expect(payload.previousStatus).toBe('running');
            expect(payload.newStatus).toBe('completed');
        });

        it('does NOT throw without an EventEmitter', () => {
            const noEmitter = new ExecutablePipelineRunner(pipeline);
            expect(() => noEmitter.markStepComplete('s1')).not.toThrow();
        });
    });

    describe('markStepFailed', () => {
        it('throws verbatim error for unknown step', () => {
            expect(() => runner.markStepFailed('nope', new Error('x'))).toThrow(
                'Step "nope" not found in pipeline',
            );
        });

        it('sets status=failed, stamps completedAt, appends to failedSteps, attaches the Error', () => {
            const err = new Error('step blew up');
            runner.startStep('s1');
            runner.markStepFailed('s1', err);
            const state = runner.getState();
            const stepState = state.steps.get('s1')!;
            expect(stepState.status).toBe('failed');
            expect(stepState.completedAt).toBeDefined();
            expect(stepState.error).toBe(err);
            expect(state.failedSteps).toEqual(['s1']);
            expect(state.currentStep).toBeUndefined();
        });

        it('does NOT add the failed step to completedSteps', () => {
            runner.markStepFailed('s1', new Error('x'));
            expect(runner.getState().completedSteps).not.toContain('s1');
        });

        it('emits STEP_STATUS_CHANGED with previousStatus="running" (HARDCODED)', () => {
            runner.markStepFailed('s1', new Error('x'));
            const payload = emitSpy.mock.calls[0][1] as StateChangePayload;
            expect(payload.previousStatus).toBe('running');
            expect(payload.newStatus).toBe('failed');
        });

        it('preserves multiple failures in append order', () => {
            runner.markStepFailed('s1', new Error('a'));
            runner.markStepFailed('s2', new Error('b'));
            expect(runner.getState().failedSteps).toEqual(['s1', 's2']);
        });

        it('does NOT throw without an EventEmitter', () => {
            const noEmitter = new ExecutablePipelineRunner(pipeline);
            expect(() => noEmitter.markStepFailed('s1', new Error('x'))).not.toThrow();
        });
    });

    describe('markStepSkipped', () => {
        it('throws verbatim error for unknown step', () => {
            expect(() => runner.markStepSkipped('nope')).toThrow(
                'Step "nope" not found in pipeline',
            );
        });

        it('sets status=skipped, stamps completedAt, appends to completedSteps (skipped is "done")', () => {
            runner.markStepSkipped('s1', 'no items to process');
            const state = runner.getState();
            const stepState = state.steps.get('s1')!;
            expect(stepState.status).toBe('skipped');
            expect(stepState.completedAt).toBeDefined();
            expect(stepState.result).toEqual({ skipReason: 'no items to process' });
            expect(state.completedSteps).toEqual(['s1']);
            expect(state.failedSteps).toEqual([]);
        });

        it('omits result when reason===undefined', () => {
            runner.markStepSkipped('s1');
            expect(runner.getStepState('s1')?.result).toBeUndefined();
            expect(runner.getStepState('s1')?.status).toBe('skipped');
        });

        it('does NOT clear currentStep (asymmetric with markStepComplete / markStepFailed)', () => {
            // Pinned: markStepSkipped notably does NOT touch currentStep, while
            // markStepComplete and markStepFailed both clear it. This is a
            // documented asymmetry — a step can be skipped while another is running.
            // A future refactor that "unifies" the three methods must be deliberate.
            runner.startStep('s1');
            runner.markStepSkipped('s2');
            expect(runner.getCurrentStep()).toBe('s1');
        });

        it('emits STEP_STATUS_CHANGED with previousStatus="pending" (HARDCODED, distinct from complete/failed)', () => {
            runner.markStepSkipped('s1');
            const payload = emitSpy.mock.calls[0][1] as StateChangePayload;
            expect(payload.previousStatus).toBe('pending');
            expect(payload.newStatus).toBe('skipped');
        });

        it('does NOT throw without an EventEmitter', () => {
            const noEmitter = new ExecutablePipelineRunner(pipeline);
            expect(() => noEmitter.markStepSkipped('s1', 'reason')).not.toThrow();
        });
    });

    describe('full lifecycle integration', () => {
        it('a 3-step pipeline emits exactly 6 STEP_STATUS_CHANGED events (running+completed per step) in order', () => {
            runner.startExecution();
            runner.startStep('s1');
            runner.markStepComplete('s1');
            runner.startStep('s2');
            runner.markStepComplete('s2');
            runner.startStep('s3');
            runner.markStepComplete('s3');
            runner.completeExecution();

            const stepEvents = emitSpy.mock.calls.filter(
                (c) => c[0] === PipelineRuntimeEvents.STEP_STATUS_CHANGED,
            );
            expect(stepEvents).toHaveLength(6);
            const transitions = stepEvents.map((c) => `${c[1].stepId}:${c[1].newStatus}`);
            expect(transitions).toEqual([
                's1:running',
                's1:completed',
                's2:running',
                's2:completed',
                's3:running',
                's3:completed',
            ]);
        });

        it('mixed lifecycle: some completed, some failed, some skipped', () => {
            runner.startExecution();
            runner.startStep('s1');
            runner.markStepComplete('s1');
            runner.startStep('s2');
            runner.markStepFailed('s2', new Error('whoops'));
            runner.markStepSkipped('s3', 'previous step failed');
            runner.completeExecution();

            const state = runner.getState();
            expect(state.completedSteps).toEqual(['s1', 's3']);
            expect(state.failedSteps).toEqual(['s2']);
            expect(state.steps.get('s1')?.status).toBe('completed');
            expect(state.steps.get('s2')?.status).toBe('failed');
            expect(state.steps.get('s3')?.status).toBe('skipped');
            expect(state.isRunning).toBe(false);
            expect(state.isCancelled).toBe(false);
        });

        it('cancellation mid-flight preserves pre-cancel completedSteps and stamps the cancellation timestamp', () => {
            runner.startExecution();
            runner.startStep('s1');
            runner.markStepComplete('s1');
            runner.startStep('s2');
            runner.cancelExecution();

            const state = runner.getState();
            expect(state.completedSteps).toEqual(['s1']);
            expect(state.steps.get('s2')?.status).toBe('running');
            expect(state.isRunning).toBe(false);
            expect(state.isCancelled).toBe(true);
            expect(state.completedAt).toBeDefined();
        });
    });
});
