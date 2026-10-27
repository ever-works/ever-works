import { describe, expect, it } from 'vitest';
import {
    FLEET_ACTIONS_RUNNER_PHASES,
    FLEET_ACTIONS_RUNNER_STATES,
    type FleetActionsRunnerTargetOption,
    type FleetActionsRunnerView,
} from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import {
    RUNNER_PHASE_KEYS,
    RUNNER_STATE_GLYPHS,
    clampInstallCount,
    defaultRunnerNames,
    defaultTarget,
    firstLine,
    formatClock,
    installRequestFrom,
    isWindowsOs,
    namesForCount,
    namesProblem,
    parseExtraLabels,
    runnerActAvailability,
    runnerActDialog,
    runnerLabelChips,
    runnerModesFor,
    runnerStatus,
    runnersInstallHref,
    runnersThatFit,
    splitSummary,
    targetFromKey,
    targetKey,
} from './runners.shared';

/** Actions runners on computers (FL-18 P1, T-15) — the pure decisions behind the block, its rows and the Install dialog. */

const rows = (
    messages as unknown as {
        fleet: {
            runners: { row: { states: Record<string, string>; phases: Record<string, string> } };
        };
    }
).fleet.runners.row;

function runner(overrides: Partial<FleetActionsRunnerView> = {}): FleetActionsRunnerView {
    return {
        id: 'r1',
        nodeId: 'n1',
        name: 'build-01-1',
        scope: 'repo',
        target: 'acme/api',
        labels: ['gpu'],
        defaultLabels: ['self-hosted', 'Linux', 'X64'],
        mode: 'service',
        state: 'idle',
        stateSource: 'github',
        stoppedByOwner: false,
        phase: null,
        lastError: null,
        githubRunnerId: 7,
        runnerVersion: '2.321.0',
        currentJob: null,
        lastSeenAt: null,
        lastCheckAt: null,
        installedAt: null,
        githubUrl: 'https://github.com/acme/api/settings/actions/runners',
        logSource: 'runner:build-01-1',
        ...overrides,
    };
}

const target = (
    over: Partial<FleetActionsRunnerTargetOption> = {},
): FleetActionsRunnerTargetOption => ({
    scope: 'repo',
    target: 'acme/api',
    accountLogin: 'acme',
    permission: 'ok',
    grantUrl: null,
    ...over,
});

describe('the palette deep link (spec §5.7)', () => {
    it('opens the computer’s Overview with the Install dialog open', () => {
        expect(runnersInstallHref('n 1')).toBe('/fleet/computers/n%201?runners=install');
    });
});

describe('runner states (spec §5.2)', () => {
    it('gives every stored state a glyph and an English label', () => {
        for (const state of FLEET_ACTIONS_RUNNER_STATES) {
            expect(RUNNER_STATE_GLYPHS[state]).toBeTruthy();
            const status = runnerStatus(runner({ state }));
            expect(status.glyph).toBe(RUNNER_STATE_GLYPHS[state]);
            expect(rows.states[status.labelKey]).toEqual(expect.any(String));
        }
    });

    it('gives every install phase an English label', () => {
        for (const phase of FLEET_ACTIONS_RUNNER_PHASES) {
            expect(rows.phases[RUNNER_PHASE_KEYS[phase]]).toEqual(expect.any(String));
        }
    });

    it('reads "stopped (by you)" only for a stop the owner asked for', () => {
        expect(runnerStatus(runner({ state: 'stopped', stoppedByOwner: true })).labelKey).toBe(
            'stoppedByYou',
        );
        expect(runnerStatus(runner({ state: 'stopped', stoppedByOwner: false })).labelKey).toBe(
            'stopped',
        );
        expect(rows.states.stoppedByYou).toBe('stopped (by you)');
    });

    it('shows the phase while installing, and only then', () => {
        expect(runnerStatus(runner({ state: 'installing', phase: 'verifying' })).phaseKey).toBe(
            'verifying',
        );
        expect(
            runnerStatus(runner({ state: 'installing', phase: 'installing-service' })).phaseKey,
        ).toBe('installingService');
        expect(runnerStatus(runner({ state: 'idle', phase: 'done' })).phaseKey).toBeNull();
    });

    it('names the first line of a failure and the discrepancy of an unknown runner (FR-17)', () => {
        const failed = runnerStatus(
            runner({
                state: 'failed',
                lastError: '\n checksum mismatch for actions-runner.tar.gz \nstack…',
            }),
        );
        expect(failed).toMatchObject({
            glyph: '✕',
            tone: 'danger',
            detail: 'checksum mismatch for actions-runner.tar.gz',
        });
        const unknown = runnerStatus(
            runner({ state: 'unknown', lastError: 'GitHub lists it, build-01 does not' }),
        );
        expect(unknown).toMatchObject({ glyph: '?', detail: 'GitHub lists it, build-01 does not' });
        expect(runnerStatus(runner({ state: 'idle', lastError: 'old' })).detail).toBeNull();
    });

    it('reads "removing" while a remove runs', () => {
        expect(runnerStatus(runner({ state: 'idle', phase: 'removing' })).labelKey).toBe(
            'removing',
        );
    });

    it('cuts a long first line', () => {
        expect(firstLine('x'.repeat(300))).toHaveLength(200);
        expect(firstLine('   ')).toBeNull();
        expect(firstLine(null)).toBeNull();
    });

    it('lists GitHub’s labels first, then the owner’s, once each', () => {
        expect(runnerLabelChips(runner({ labels: ['gpu', 'linux'] }))).toEqual([
            'self-hosted',
            'Linux',
            'X64',
            'gpu',
        ]);
    });

    it('formats the last check as a clock time', () => {
        const at = new Date(2026, 9, 26, 9, 41, 12).toISOString();
        expect(formatClock(at)).toBe('09:41');
        expect(formatClock(null)).toBeNull();
        expect(formatClock('not a date')).toBeNull();
    });
});

describe('row acts per state', () => {
    it('offers Start when stopped or offline, Stop when idle or working, Restart when idle, working or offline', () => {
        expect(runnerActAvailability(runner({ state: 'idle' }))).toEqual({
            start: 'hidden',
            stop: 'enabled',
            restart: 'enabled',
            remove: 'enabled',
        });
        expect(runnerActAvailability(runner({ state: 'working' }))).toEqual({
            start: 'hidden',
            stop: 'enabled',
            restart: 'enabled',
            remove: 'enabled',
        });
        expect(runnerActAvailability(runner({ state: 'offline' }))).toEqual({
            start: 'enabled',
            stop: 'hidden',
            restart: 'enabled',
            remove: 'enabled',
        });
        expect(runnerActAvailability(runner({ state: 'stopped', stoppedByOwner: true }))).toEqual({
            start: 'enabled',
            stop: 'hidden',
            restart: 'hidden',
            remove: 'enabled',
        });
    });

    it('leaves only Remove on a failed or unknown runner', () => {
        for (const state of ['failed', 'unknown'] as const) {
            expect(runnerActAvailability(runner({ state }))).toEqual({
                start: 'hidden',
                stop: 'hidden',
                restart: 'hidden',
                remove: 'enabled',
            });
        }
    });

    it('disables every act but Remove while installing, and everything while a remove runs', () => {
        expect(
            runnerActAvailability(runner({ state: 'installing', phase: 'downloading' })),
        ).toEqual({
            start: 'hidden',
            stop: 'disabled',
            restart: 'disabled',
            remove: 'enabled',
        });
        expect(runnerActAvailability(runner({ state: 'idle', phase: 'removing' }))).toEqual({
            start: 'hidden',
            stop: 'hidden',
            restart: 'hidden',
            remove: 'disabled',
        });
    });

    it('confirms Stop and Restart with the contracts’ sentence, Remove by the typed name, Start not at all', () => {
        const row = runner();
        expect(runnerActDialog('start', row, 'build-01')).toBeNull();
        expect(runnerActDialog('stop', row, 'build-01')).toEqual({
            class: 'confirm',
            title: 'Stop build-01-1?',
            body: 'It stops taking jobs until you start it. A job in progress finishes first.',
        });
        expect(runnerActDialog('restart', row, 'build-01')).toMatchObject({
            class: 'confirm',
            title: 'Restart build-01-1?',
        });
        expect(runnerActDialog('remove', row, 'build-01')).toEqual({
            class: 'confirm-destructive',
            title: 'Remove build-01-1?',
            body: 'Deregisters it from acme/api, uninstalls the service and deletes its folder on build-01.',
            typeName: 'build-01-1',
        });
    });

    it('keeps a summary without a question whole', () => {
        expect(splitSummary('Do it.')).toEqual({ title: 'Do it.' });
    });
});

describe('the Install dialog (spec §5.1)', () => {
    it('offers Service only on Windows, whatever the server lists', () => {
        expect(isWindowsOs('win32')).toBe(true);
        expect(runnerModesFor('win32', ['service', 'docker'], true)).toEqual(['service']);
        expect(runnerModesFor('windows', ['service'])).toEqual(['service']);
    });

    it('never offers the container mode in P1, and only on Linux hosts that advertise it once shipped', () => {
        expect(runnerModesFor('linux', ['service', 'docker'])).toEqual(['service']);
        expect(runnerModesFor('linux', ['service', 'docker'], true)).toEqual(['service', 'docker']);
        expect(runnerModesFor('darwin', ['service', 'docker'], true)).toEqual(['service']);
        expect(runnerModesFor('linux', [])).toEqual([]);
    });

    it('names new runners <computer>-<n>, skipping names the computer already has', () => {
        expect(defaultRunnerNames('build-01', 2)).toEqual(['build-01-1', 'build-01-2']);
        expect(defaultRunnerNames('build-01', 2, ['BUILD-01-1'])).toEqual([
            'build-01-2',
            'build-01-3',
        ]);
        expect(defaultRunnerNames('My Laptop!', 1)).toEqual(['My-Laptop-1']);
    });

    it('keeps edited names when the count changes and fills new slots from the suggestions', () => {
        const suggested = ['build-01-1', 'build-01-2', 'build-01-3'];
        expect(namesForCount(['gpu-a'], 3, suggested)).toEqual([
            'gpu-a',
            'build-01-1',
            'build-01-2',
        ]);
        expect(namesForCount(['build-01-2', 'gpu-a'], 3, suggested)).toEqual([
            'build-01-2',
            'gpu-a',
            'build-01-1',
        ]);
        expect(namesForCount(['a', 'b', 'c'], 1, suggested)).toEqual(['a']);
    });

    it('refuses a bad or repeated name', () => {
        expect(namesProblem(['build-01-1', 'build-01-2'])).toBeNull();
        expect(namesProblem(['build 01'])).toEqual({ kind: 'invalid', index: 0 });
        expect(namesProblem(['a-1', 'A-1'])).toEqual({ kind: 'duplicate', index: 1 });
    });

    it('clamps the count into 1 … what still fits (16 per computer)', () => {
        expect(runnersThatFit({ maxPerNode: 16, existing: 14 })).toBe(2);
        expect(runnersThatFit({ maxPerNode: 16, existing: 20 })).toBe(0);
        expect(clampInstallCount(5, 2)).toBe(2);
        expect(clampInstallCount('nonsense', 2)).toBe(1);
        expect(clampInstallCount(0, 16)).toBe(1);
        expect(clampInstallCount(40, 16)).toBe(16);
    });

    it('cleans extra labels and names the first bad one', () => {
        expect(parseExtraLabels('gpu, large, self-hosted, GPU', ['self-hosted', 'Linux'])).toEqual({
            labels: ['gpu', 'large'],
            invalid: null,
            tooMany: false,
        });
        expect(parseExtraLabels('gpu, has space', [])).toMatchObject({ invalid: 'has space' });
        const many = Array.from({ length: 21 }, (_, index) => `l${index}`).join(',');
        expect(parseExtraLabels(many, []).tooMany).toBe(true);
    });

    it('picks a usable repository first and round-trips target keys', () => {
        const targets = [
            target({ scope: 'org', target: 'acme' }),
            target({ scope: 'repo', target: 'acme/web', permission: 'missing' }),
            target({ scope: 'repo', target: 'acme/api' }),
        ];
        expect(defaultTarget(targets)?.target).toBe('acme/api');
        expect(targetFromKey(targetKey(targets[0]), targets)).toBe(targets[0]);
        expect(targetFromKey('repo:nope/nope', targets)).toBeNull();
        expect(defaultTarget([])).toBeNull();
    });

    it('sends confirm: true with one name per runner and the extra labels', () => {
        expect(
            installRequestFrom(
                {
                    targetKey: 'repo:acme/api',
                    count: 2,
                    names: [' build-01-1', 'build-01-2'],
                    labelsText: 'gpu',
                    mode: 'service',
                },
                target(),
                ['gpu'],
            ),
        ).toEqual({
            target: { scope: 'repo', target: 'acme/api' },
            count: 2,
            names: ['build-01-1', 'build-01-2'],
            labels: ['gpu'],
            mode: 'service',
            confirm: true,
        });
        expect(
            installRequestFrom(
                { targetKey: 'org:acme', count: 1, names: [], labelsText: '', mode: 'service' },
                target({ scope: 'org', target: 'acme' }),
                [],
            ),
        ).toEqual({
            target: { scope: 'org', target: 'acme' },
            count: 1,
            mode: 'service',
            confirm: true,
        });
    });
});
