import { describe, expect, it } from 'vitest';
import type { FleetCommandRunView, FleetNodeView } from '@ever-works/contracts';
import {
    commandCardEnd,
    commandPickRow,
    commandPickRows,
    commandPreselection,
    commandSummaryLine,
    formatCommandClock,
    formatCommandDuration,
    readCommandConfirmation,
} from './commands.shared';

function node(over: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: ['managed'],
        lastHeartbeatAt: '2026-10-21T10:00:00.000Z',
        createdAt: null,
        persisted: true,
        consents: { work: true, attend: false, manage: true, usageScan: false },
        link: { state: 'connected', bytesIn: 0, bytesOut: 0, openChannels: 0 },
        viewerRole: 'owner',
        ...over,
    } as FleetNodeView;
}

function run(over: Partial<FleetCommandRunView> = {}): FleetCommandRunView {
    return {
        id: 'r1',
        commandId: 'c1',
        nodeId: 'n1',
        nodeName: 'build-01',
        status: 'done',
        failedReason: null,
        exitCode: 0,
        error: null,
        startedAt: '2026-10-21T10:00:00.000Z',
        endedAt: '2026-10-21T10:00:00.800Z',
        durationMs: 800,
        outputHead: 'ok',
        outputTail: '',
        truncated: false,
        capped: false,
        outputBytes: 2,
        hasFullOutput: true,
        linkDown: false,
        ...over,
    };
}

describe('the picker (spec S2, FR-15, U4)', () => {
    it('offers an online managed computer with its link up', () => {
        expect(commandPickRow(node())).toMatchObject({ selectable: true, reason: null, os: 'Linux' });
    });

    it('greys a computer without --manage, an offline one and one whose policy leaves the viewer out', () => {
        expect(
            commandPickRow(node({ consents: { work: true, attend: false, manage: false, usageScan: false } })).reason,
        ).toBe('manageOff');
        expect(commandPickRow(node({ status: 'offline' })).reason).toBe('offline');
        expect(
            commandPickRow(node({ viewerRole: 'org-member', controlPolicyFamilies: undefined, controlPolicy: undefined }))
                .reason,
        ).toBe('notAllowed');
        expect(
            commandPickRow(node({ link: { state: 'reconnecting', bytesIn: 0, bytesOut: 0, openChannels: 0 } })).reason,
        ).toBe('linkDown');
    });

    it('preselects every selectable computer, or only the one a computer page asked for', () => {
        const rows = commandPickRows([
            node({ id: 'a', status: 'offline' }),
            node({ id: 'b' }),
            node({ id: 'c' }),
        ]);
        expect(rows.map((row) => row.nodeId)).toEqual(['b', 'c', 'a']);
        expect(commandPreselection(rows)).toEqual(['b', 'c']);
        expect(commandPreselection(rows, 'c')).toEqual(['c']);
        expect(commandPreselection(rows, 'a')).toEqual([]);
    });
});

describe('a card end line', () => {
    it('reads ✓ and the duration, Exit N, a timeout and the stops', () => {
        expect(commandCardEnd(run())).toMatchObject({ key: 'done', values: { duration: '0.8 s' } });
        expect(commandCardEnd(run({ status: 'failed', exitCode: 128, durationMs: 1200 }))).toMatchObject({
            key: 'exit',
            values: { code: 128, duration: '1.2 s' },
        });
        expect(commandCardEnd(run({ status: 'timeout', exitCode: 124, durationMs: 600_000 }))).toMatchObject({
            key: 'timedOut',
            values: { clock: '10:00' },
        });
        expect(commandCardEnd(run({ status: 'failed', failedReason: 'kill-switch' })).key).toBe('killSwitch');
        expect(commandCardEnd(run({ status: 'failed', failedReason: 'drain' })).key).toBe('drain');
    });

    it('names a refusal by its hint and a lost connection while running', () => {
        expect(
            commandCardEnd(
                run({
                    status: 'failed',
                    exitCode: null,
                    error: { code: 'unreachable', hint: 'build-01 is offline — last seen 2 h ago' },
                }),
            ),
        ).toMatchObject({ key: 'refused', values: { hint: 'build-01 is offline — last seen 2 h ago' } });
        expect(commandCardEnd(run({ status: 'running', linkDown: true })).key).toBe('linkDown');
    });
});

describe('the summary line (spec S1)', () => {
    it('says all done, n of m failed, or how many still run', () => {
        expect(
            commandSummaryLine({ total: 2, running: 0, succeeded: 2, failed: 0, timedOut: 0, longestMs: 900 }),
        ).toEqual({ key: 'allDone', values: { duration: '0.9 s' } });
        expect(
            commandSummaryLine({ total: 2, running: 0, succeeded: 1, failed: 1, timedOut: 0, longestMs: 1200 }),
        ).toEqual({ key: 'someFailed', values: { failed: 1, total: 2, duration: '1.2 s' } });
        expect(
            commandSummaryLine({ total: 2, running: 1, succeeded: 1, failed: 0, timedOut: 0, longestMs: 1200 }).key,
        ).toBe('running');
    });
});

describe('formats and the confirmation', () => {
    it('formats clocks and durations', () => {
        expect(formatCommandClock(61_000)).toBe('1:01');
        expect(formatCommandClock(3_661_000)).toBe('1:01:01');
        expect(formatCommandDuration(59_000)).toBe('59.0 s');
        expect(formatCommandDuration(null)).toBe('');
    });

    it('reads only a confirm-class summary', () => {
        expect(readCommandConfirmation({ class: 'confirm', summary: [] })).not.toBeNull();
        expect(readCommandConfirmation({ class: 'confirm-destructive', summary: [] })).toBeNull();
    });
});
