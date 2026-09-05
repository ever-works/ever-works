import { describe, expect, it } from 'vitest';
import type { FleetRunnerNodeView } from '@ever-works/contracts';
import {
    formatBytes,
    relativeTimeParts,
    runnerDotClass,
    runnerRowState,
} from './runner-status.shared';

const node = (overrides: Partial<FleetRunnerNodeView> = {}): FleetRunnerNodeView => ({
    id: 'n1',
    name: 'laptop',
    kind: 'desktop-node',
    status: 'online',
    lastHeartbeatAt: null,
    daemonVersion: '1.0.0',
    cliVersion: null,
    diskFreeBytes: null,
    // Fleet cost accounting (EW-777): the seat the spend is billed to.
    modelIdentity: null,
    busy: false,
    activeJobCount: 0,
    currentJobKind: null,
    ...overrides,
});

describe('runnerRowState', () => {
    it('promotes busy ahead of the registry status', () => {
        // "Busy" is the more specific TRUE statement, and it answers the
        // question the operator is actually asking ("can it take my
        // work?") instead of leaving them to infer it from a job count.
        expect(runnerRowState(node({ status: 'online', busy: true }))).toBe('busy');
        expect(runnerRowState(node({ status: 'online', busy: false }))).toBe('online');
    });

    it('never reports a non-online node as busy', () => {
        // A drained node keeps heartbeating and may still be finishing an
        // in-flight claim; showing it as "Busy" would hide the drain.
        expect(runnerRowState(node({ status: 'paused', busy: true }))).toBe('paused');
        expect(runnerRowState(node({ status: 'disabled', busy: true }))).toBe('disabled');
        expect(runnerRowState(node({ status: 'offline', busy: true }))).toBe('offline');
    });
});

describe('runnerDotClass', () => {
    it('gives online, busy, enrolling and disabled distinct colours', () => {
        const classes = ['online', 'busy', 'enrolling', 'disabled'].map((state) =>
            runnerDotClass(state as ReturnType<typeof runnerRowState>),
        );
        expect(new Set(classes).size).toBe(4);
    });

    it('falls back to the muted dot for offline and paused', () => {
        expect(runnerDotClass('offline')).toBe(runnerDotClass('paused'));
    });
});

describe('formatBytes', () => {
    it('formats with SI units the way a desktop OS reports free space', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(999)).toBe('999 B');
        expect(formatBytes(1000)).toBe('1.0 KB');
        expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
        expect(formatBytes(45_000_000_000)).toBe('45 GB');
    });

    it('returns null for unknown so the caller can render a dash', () => {
        // Not "0 B" — that reads as a FULL disk, which is the opposite of
        // "we have no reading".
        expect(formatBytes(null)).toBeNull();
        expect(formatBytes(undefined)).toBeNull();
        expect(formatBytes(-1)).toBeNull();
        expect(formatBytes(Number.NaN)).toBeNull();
    });
});

describe('relativeTimeParts', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');

    it('reports whole units, coarsening as the gap grows', () => {
        expect(relativeTimeParts('2026-01-01T11:59:55.000Z', now)).toEqual({
            unit: 'second',
            value: 5,
        });
        expect(relativeTimeParts('2026-01-01T11:56:00.000Z', now)).toEqual({
            unit: 'minute',
            value: 4,
        });
        expect(relativeTimeParts('2026-01-01T09:00:00.000Z', now)).toEqual({
            unit: 'hour',
            value: 3,
        });
        expect(relativeTimeParts('2025-12-30T12:00:00.000Z', now)).toEqual({
            unit: 'day',
            value: 2,
        });
    });

    it('clamps a node whose clock runs ahead of the server to 0', () => {
        // "in 3 seconds" reads as a bug rather than as clock skew.
        expect(relativeTimeParts('2026-01-01T12:00:03.000Z', now)).toEqual({
            unit: 'second',
            value: 0,
        });
    });

    it('returns null for a missing or unparseable timestamp', () => {
        expect(relativeTimeParts(null, now)).toBeNull();
        expect(relativeTimeParts(undefined, now)).toBeNull();
        expect(relativeTimeParts('', now)).toBeNull();
        expect(relativeTimeParts('not-a-date', now)).toBeNull();
    });
});
