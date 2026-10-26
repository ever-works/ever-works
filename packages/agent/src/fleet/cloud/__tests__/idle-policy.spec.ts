import type { FleetCloudMeta } from '@ever-works/contracts';
import { evaluateCloudIdle, isIdleNow, type CloudIdleEvidence } from '../idle-policy';

/** Cloud computers (FL-17 P2, T-24, spec FR-25 – FR-28) — the idle truth table. */

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const NODE = '0f8fad5b-d9cb-469f-a165-70867728950e';

function meta(overrides: Partial<FleetCloudMeta> = {}): FleetCloudMeta {
    return {
        providerName: 'Provider',
        regionId: 'fra1',
        regionLabel: 'Frankfurt 1',
        sizeId: 's-4',
        sizeLabel: '4 CPU',
        vcpus: 4,
        memoryMiB: 8192,
        diskGiB: 160,
        hourlyRateCents: 7.1,
        monthlyPriceCents: 4800,
        currency: 'USD',
        billsWhileOff: true,
        createdAt: '2026-10-20T00:00:00.000Z',
        machineCreatedAt: '2026-10-20T00:00:00.000Z',
        phase: 'online',
        phaseAt: '2026-10-20T00:05:00.000Z',
        powerState: 'running',
        powerStateAt: '2026-10-20T00:05:00.000Z',
        pending: null,
        powerTimeline: [],
        error: null,
        idlePolicy: { mode: 'tell-me', afterHours: 3 },
        idleSince: null,
        software: [],
        tags: [],
        ...overrides,
    };
}

function evidence(overrides: Partial<CloudIdleEvidence> = {}): CloudIdleEvidence {
    return {
        nodeId: NODE,
        status: 'online',
        meta: meta(),
        busySessions: 0,
        activeJobs: 0,
        cpuSamples: [1.2, 0.4],
        nowMs: NOW,
        ...overrides,
    };
}

describe('cloud idle policy (FL-17 P2)', () => {
    it('counts a quiet running machine as idle', () => {
        expect(isIdleNow(evidence())).toBe(true);
    });

    it('is broken by a working session, a running job or CPU at 5 % or more', () => {
        expect(isIdleNow(evidence({ busySessions: 1 }))).toBe(false);
        expect(isIdleNow(evidence({ activeJobs: 1 }))).toBe(false);
        expect(isIdleNow(evidence({ cpuSamples: [1, 5] }))).toBe(false);
        expect(isIdleNow(evidence({ cpuSamples: [null, 4.9] }))).toBe(true);
    });

    it('never counts a powered-off, enrolling, pending or failed machine (FR-26, U11)', () => {
        expect(isIdleNow(evidence({ meta: meta({ powerState: 'off' }) }))).toBe(false);
        expect(isIdleNow(evidence({ status: 'enrolling' }))).toBe(false);
        expect(isIdleNow(evidence({ meta: meta({ pending: 'powering-off' }) }))).toBe(false);
        expect(isIdleNow(evidence({ meta: meta({ phase: 'failed' }) }))).toBe(false);
    });

    it('opens a window, then acts once when it reaches the policy hours', () => {
        const opened = evaluateCloudIdle(evidence());
        expect(opened.idleSince).toBe(new Date(NOW).toISOString());
        expect(opened.windowReached).toBe(false);
        expect(opened.act).toBe('none');

        const later = NOW + 3 * 60 * 60 * 1000;
        const due = evaluateCloudIdle(evidence({ meta: meta({ idleSince: opened.idleSince }), nowMs: later }));
        expect(due.windowReached).toBe(true);
        expect(due.act).toBe('tell-me');
        expect(due.attentionKey).toBe(`fleet-node:${NODE}:cloud-idle:${opened.idleSince}`);

        // The same window never acts twice (FR-27).
        const again = evaluateCloudIdle(
            evidence({
                meta: meta({ idleSince: opened.idleSince, idleNotifiedKey: due.attentionKey }),
                nowMs: later + 10 * 60 * 1000,
            }),
        );
        expect(again.act).toBe('none');
    });

    it('powers off when told, and does nothing for "nothing"', () => {
        const since = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
        expect(
            evaluateCloudIdle(evidence({ meta: meta({ idleSince: since, idlePolicy: { mode: 'power-off', afterHours: 2 } }) })).act,
        ).toBe('power-off');
        expect(
            evaluateCloudIdle(evidence({ meta: meta({ idleSince: since, idlePolicy: { mode: 'nothing', afterHours: 1 } }) })).act,
        ).toBe('none');
    });

    it('closes the window when the machine gets busy', () => {
        const since = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
        expect(evaluateCloudIdle(evidence({ meta: meta({ idleSince: since }), busySessions: 1 }))).toEqual({
            idleSince: null,
            windowReached: false,
            act: 'none',
            attentionKey: null,
        });
    });
});
