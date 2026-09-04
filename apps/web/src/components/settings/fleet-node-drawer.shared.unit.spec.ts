import { describe, expect, it } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import {
    FLEET_JOB_FILTERS,
    filterFleetJobs,
    fleetJobDurationMs,
    formatFleetJobDuration,
} from './fleet-node-drawer.shared';

function job(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: 'node-1',
        targetNodeId: null,
        requiredCapabilities: [],
        payload: null,
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: '2026-09-01T10:00:00.000Z',
        startedAt: '2026-09-01T10:00:05.000Z',
        completedAt: '2026-09-01T10:01:17.000Z',
        queuedReason: null,
        ...over,
    };
}

describe('filterFleetJobs', () => {
    const jobs = [
        job({ id: 'queued', status: 'queued', startedAt: null, completedAt: null }),
        job({ id: 'leased', status: 'leased', completedAt: null }),
        job({ id: 'running', status: 'running', completedAt: null }),
        job({ id: 'done', status: 'done' }),
        job({ id: 'failed', status: 'failed' }),
    ];

    it('exposes the chips in All / Failed / Running order', () => {
        expect(FLEET_JOB_FILTERS).toEqual(['all', 'failed', 'running']);
    });

    it('"all" returns a copy of every job in the original order', () => {
        const result = filterFleetJobs(jobs, 'all');
        expect(result.map((entry) => entry.id)).toEqual([
            'queued',
            'leased',
            'running',
            'done',
            'failed',
        ]);
        expect(result).not.toBe(jobs);
    });

    it('"failed" keeps only failed jobs', () => {
        expect(filterFleetJobs(jobs, 'failed').map((entry) => entry.id)).toEqual(['failed']);
    });

    /**
     * A leased job is claimed and about to run; hiding it would make a
     * node that just picked up work look idle until its first heartbeat.
     */
    it('"running" keeps every job a node currently holds a claim on', () => {
        expect(filterFleetJobs(jobs, 'running').map((entry) => entry.id)).toEqual([
            'leased',
            'running',
        ]);
    });
});

describe('fleetJobDurationMs', () => {
    const NOW = new Date('2026-09-01T10:03:00.000Z').getTime();

    it('is null for a job that never started', () => {
        expect(fleetJobDurationMs(job({ startedAt: null }), NOW)).toBeNull();
    });

    it('measures a completed job between its two stamps', () => {
        expect(fleetJobDurationMs(job(), NOW)).toBe(72_000);
    });

    it('measures a job still running against the injected clock', () => {
        expect(fleetJobDurationMs(job({ status: 'running', completedAt: null }), NOW)).toBe(
            175_000,
        );
    });

    it('clamps clock skew to zero instead of going negative', () => {
        expect(fleetJobDurationMs(job({ completedAt: '2026-09-01T10:00:01.000Z' }), NOW)).toBe(0);
    });

    it('is null for an unparseable stamp', () => {
        expect(fleetJobDurationMs(job({ startedAt: 'not a date' }), NOW)).toBeNull();
    });
});

describe('formatFleetJobDuration', () => {
    it('renders sub-second spans in milliseconds', () => {
        expect(formatFleetJobDuration(820)).toBe('820ms');
    });

    it('renders seconds, then minutes with seconds, then hours with minutes', () => {
        expect(formatFleetJobDuration(12_000)).toBe('12s');
        expect(formatFleetJobDuration(252_000)).toBe('4m 12s');
        expect(formatFleetJobDuration(5_640_000)).toBe('1h 34m');
    });

    it('returns null for an unknown span so the caller renders a dash', () => {
        expect(formatFleetJobDuration(null)).toBeNull();
        expect(formatFleetJobDuration(undefined)).toBeNull();
        expect(formatFleetJobDuration(-1)).toBeNull();
        expect(formatFleetJobDuration(Number.NaN)).toBeNull();
    });
});
