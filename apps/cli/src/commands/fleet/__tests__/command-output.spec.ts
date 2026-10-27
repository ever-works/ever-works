import { describe, expect, it } from 'vitest';
import { fleetCommandCliExitCode, type FleetCommandRunView } from '@ever-works/contracts';
import {
    describeRunEnd,
    describeSummary,
    newRunPrintState,
    resolveNodeTokens,
    takeNewLines,
} from '../command-output';

/**
 * `ever-works fleet commands run` (FL-12, spec FR-19, S6) — the pure half:
 * `--on` resolution, line streaming and the end words; the exit codes come
 * from the shared contract (0 · 1 · 124; 2 is a usage error before any call).
 */

const NODES = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'build-01' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'build-02' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'twin' },
    { id: '44444444-4444-4444-8444-444444444444', name: 'TWIN' },
];

function run(over: Partial<FleetCommandRunView> = {}): FleetCommandRunView {
    return {
        id: 'r1',
        commandId: 'c1',
        nodeId: NODES[0].id,
        nodeName: 'build-01',
        status: 'running',
        failedReason: null,
        exitCode: null,
        error: null,
        startedAt: '2026-10-21T10:00:00.000Z',
        endedAt: null,
        durationMs: 500,
        outputHead: '',
        outputTail: '',
        truncated: false,
        capped: false,
        outputBytes: 0,
        hasFullOutput: false,
        linkDown: false,
        ...over,
    };
}

describe('resolveNodeTokens', () => {
    it('resolves names case-insensitively and ids, keeping the order', () => {
        expect(resolveNodeTokens('Build-02, build-01', NODES).ids).toEqual([
            NODES[1].id,
            NODES[0].id,
        ]);
        expect(resolveNodeTokens(NODES[0].id, NODES).ids).toEqual([NODES[0].id]);
    });

    it('reports unknown and ambiguous names', () => {
        expect(resolveNodeTokens('nope,twin', NODES)).toEqual({
            ids: [],
            unknown: ['nope'],
            ambiguous: ['twin'],
        });
    });
});

describe('takeNewLines', () => {
    it('hands out whole lines while running and the rest at the end', () => {
        const state = newRunPrintState();
        expect(takeNewLines(run({ outputHead: 'a\nb' }), state)).toEqual(['a']);
        expect(takeNewLines(run({ outputHead: 'a\nbc\nd' }), state)).toEqual(['bc']);
        expect(
            takeNewLines(run({ status: 'done', exitCode: 0, outputHead: 'a\nbc\nde\n' }), state),
        ).toEqual(['de']);
        expect(takeNewLines(run({ status: 'done', outputHead: 'a\nbc\nde\n' }), state)).toEqual([]);
    });

    it('prints the marker and the tail of a truncated run once', () => {
        const state = newRunPrintState();
        const lines = takeNewLines(
            run({
                status: 'done',
                exitCode: 0,
                outputHead: 'head\n',
                outputTail: 'tail1\ntail2\n',
                truncated: true,
            }),
            state,
        );
        expect(lines).toEqual(['head', '… first 64 KiB and last 64 KiB shown …', 'tail1', 'tail2']);
    });
});

describe('end words and exit codes', () => {
    it('says what the hub says', () => {
        expect(describeRunEnd(run({ status: 'done', exitCode: 0, durationMs: 800 }))).toBe(
            '✓ 0.8 s',
        );
        expect(describeRunEnd(run({ status: 'failed', exitCode: 128, durationMs: 1200 }))).toBe(
            'Exit 128 · 1.2 s',
        );
        expect(
            describeRunEnd(
                run({
                    status: 'failed',
                    error: {
                        code: 'consent_missing',
                        hint: 'start the node with --manage on build-01',
                    },
                }),
            ),
        ).toBe('consent_missing: start the node with --manage on build-01');
        expect(
            describeSummary({
                total: 2,
                running: 0,
                succeeded: 1,
                failed: 1,
                timedOut: 0,
                longestMs: 1200,
            }),
        ).toBe('1 of 2 failed · 1.2 s');
    });

    it('exits 0, 1 or 124', () => {
        expect(fleetCommandCliExitCode([run({ status: 'done' })])).toBe(0);
        expect(fleetCommandCliExitCode([run({ status: 'done' }), run({ status: 'failed' })])).toBe(
            1,
        );
        expect(fleetCommandCliExitCode([run({ status: 'timeout' })])).toBe(124);
    });
});
