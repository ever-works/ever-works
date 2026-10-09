import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import type { FleetJobView } from '@ever-works/contracts';
import {
    classifyFleetRunCompletion,
    FLEET_RUN_TELEMETRY_EVENTS,
    FleetRunTelemetryListener,
} from '../fleet-run-telemetry.listener';

/**
 * Self-build slice AP — fleet run lifecycle telemetry.
 *
 * Pinned, in order of how much it would hurt to lose:
 *
 *   1. NOTHING user- or model-authored reaches PostHog or Sentry: not the
 *      payload (the assembled prompt), not the summary / transcript / step
 *      text of the result, not the node's error string;
 *   2. each lifecycle transition is ONE event, classified the way the
 *      reconciler classifies it (cancelled wins);
 *   3. telemetry never throws into the event bus, and is a no-op when the
 *      monitoring services are not bound.
 */
const USER = 'user-1';
const NODE = '11111111-1111-4111-8111-111111111111';
const SECRET_PROMPT = 'PROMPT-the-whole-assembled-instructions';
const SECRET_TEXT = 'MODEL-TEXT-that-must-not-leave';

function job(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: NODE,
        requiredCapabilities: ['workspace'],
        payload: { runId: 'run-1', taskId: 'task-1', execution: { instructions: SECRET_PROMPT } },
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: '2026-10-08T10:00:00.000Z',
        queuedAt: '2026-10-08T10:00:00.000Z',
        startedAt: '2026-10-08T10:00:05.000Z',
        completedAt: '2026-10-08T10:20:05.000Z',
        leaseGeneration: 1,
        ...over,
    };
}

const result = {
    status: 'succeeded',
    gateStatus: 'green',
    summary: SECRET_TEXT,
    model: {
        provider: 'claude-code',
        status: 'succeeded',
        durationMs: 1_190_000,
        costUsd: 1.25,
        turns: 12,
        totalTokens: 90_000,
        summary: SECRET_TEXT,
        transcript: SECRET_TEXT,
        timeline: [{ kind: 'assistant-message', atMs: 1, text: SECRET_TEXT }],
    },
    git: { pushed: true, branch: 'task/x' },
};

describe('FleetRunTelemetryListener', () => {
    let analytics: { track: jest.Mock };
    let sentry: { info: jest.Mock; warn: jest.Mock };

    beforeEach(() => {
        analytics = { track: jest.fn() };
        sentry = { info: jest.fn(), warn: jest.fn() };
    });

    const listener = () => new FleetRunTelemetryListener(analytics as never, sentry as never);

    it('emits fleet_run_leased with identifiers and the queue wait only', () => {
        listener().onLeased(
            new FleetJobLeasedEvent(job({ status: 'leased', completedAt: null }), NODE, USER),
        );
        expect(analytics.track).toHaveBeenCalledWith(USER, 'fleet_run_leased', {
            jobId: 'job-1',
            kind: 'agent-task',
            nodeId: NODE,
            attempts: 1,
            maxAttempts: 3,
            leaseGeneration: 1,
            queuedMs: 5000,
        });
        expect(sentry.info).toHaveBeenCalledWith(
            'fleet.run.leased',
            expect.objectContaining({ jobId: 'job-1' }),
        );
    });

    it('emits fleet_run_completed with duration, cost and the CLI verdict — and NO payload or result text', () => {
        listener().onCompleted(
            new FleetJobCompletedEvent(
                job(),
                USER,
                'node-report',
                NODE,
                result,
                'node said: ' + SECRET_TEXT,
            ),
        );
        expect(analytics.track).toHaveBeenCalledTimes(1);
        const [distinctId, name, properties] = analytics.track.mock.calls[0];
        expect(distinctId).toBe(USER);
        expect(name).toBe('fleet_run_completed');
        expect(properties).toEqual({
            jobId: 'job-1',
            kind: 'agent-task',
            nodeId: NODE,
            attempts: 1,
            maxAttempts: 3,
            leaseGeneration: 1,
            source: 'node-report',
            queuedMs: 5000,
            durationMs: 1_200_000,
            resultStatus: 'succeeded',
            gateStatus: 'green',
            provider: 'claude-code',
            modelStatus: 'succeeded',
            costUsd: 1.25,
            turns: 12,
            totalTokens: 90_000,
            modelDurationMs: 1_190_000,
            timelineSteps: 1,
            pushed: true,
        });
        const sent = JSON.stringify([
            analytics.track.mock.calls,
            sentry.info.mock.calls,
            sentry.warn.mock.calls,
        ]);
        expect(sent).not.toContain(SECRET_PROMPT);
        expect(sent).not.toContain(SECRET_TEXT);
        expect(sentry.info).toHaveBeenCalledWith('fleet.run.completed', properties);
    });

    it('classifies a node-reported FAILED run as failed, logged to Sentry as a warning (never an exception)', () => {
        const failed = { ...result, status: 'failed', gateStatus: 'red' };
        listener().onCompleted(
            new FleetJobCompletedEvent(job(), USER, 'node-report', NODE, failed),
        );
        expect(analytics.track).toHaveBeenCalledWith(
            USER,
            'fleet_run_failed',
            expect.objectContaining({ gateStatus: 'red' }),
        );
        expect(sentry.warn).toHaveBeenCalledWith('fleet.run.failed', expect.any(Object));
        expect(sentry.info).not.toHaveBeenCalled();
    });

    it('classifies lease exhaustion and the queue SLA as failed, with their source', () => {
        listener().onCompleted(
            new FleetJobCompletedEvent(job({ status: 'failed' }), USER, 'lease-exhausted'),
        );
        listener().onCompleted(
            new FleetJobCompletedEvent(
                job({ status: 'failed', startedAt: null }),
                USER,
                'queue-expired',
            ),
        );
        expect(analytics.track.mock.calls.map(([, name, props]) => [name, props.source])).toEqual([
            ['fleet_run_failed', 'lease-exhausted'],
            ['fleet_run_failed', 'queue-expired'],
        ]);
    });

    it('classifies every cancelled arrival as cancelled, a late success included', () => {
        const cases = [
            new FleetJobCompletedEvent(job({ status: 'failed' }), USER, 'cancelled'),
            new FleetJobCompletedEvent(
                job({ cancelRequestedAt: '2026-10-08T10:10:00.000Z' }),
                USER,
                'node-report',
                NODE,
                result,
            ),
        ];
        expect(cases.map(classifyFleetRunCompletion)).toEqual(['cancelled', 'cancelled']);
        for (const event of cases) listener().onCompleted(event);
        expect(analytics.track.mock.calls.map(([, name]) => name)).toEqual([
            'fleet_run_cancelled',
            'fleet_run_cancelled',
        ]);
    });

    it('never throws into the event bus, and is a no-op with no monitoring bound', () => {
        analytics.track.mockImplementation(() => {
            throw new Error('posthog down');
        });
        sentry.info.mockImplementation(() => {
            throw new Error('sentry down');
        });
        expect(() =>
            listener().onCompleted(
                new FleetJobCompletedEvent(job(), USER, 'node-report', NODE, result),
            ),
        ).not.toThrow();
        expect(() =>
            new FleetRunTelemetryListener().onLeased(new FleetJobLeasedEvent(job(), NODE, USER)),
        ).not.toThrow();
    });

    it('names exactly four lifecycle events', () => {
        expect(FLEET_RUN_TELEMETRY_EVENTS).toEqual({
            leased: 'fleet_run_leased',
            completed: 'fleet_run_completed',
            failed: 'fleet_run_failed',
            cancelled: 'fleet_run_cancelled',
        });
    });
});
