import { describe, expect, it } from 'vitest';
import {
    FLEET_ACTIONS_JOB_DIAGNOSES,
    FLEET_ACTIONS_MAX_WATCHED_TARGETS,
    FLEET_ACTIONS_RUNNER_PHASES,
    FLEET_ACTIONS_RUNNER_STATES,
    type FleetActionsJobView,
    type FleetActionsRunnerTargetOption,
    type FleetActionsRunnerView,
} from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import {
    ACTIONS_JOBS_ANCHOR,
    ACTIONS_JOB_PARAM,
    actionsJobKey,
    actionsJobParamValue,
    actionsJobsHref,
    actionsJobsPanelHasContent,
    addWatchedTarget,
    cancelRunDialog,
    cancelRunRequest,
    formatWaited,
    isHighlightedJob,
    jobCounts,
    jobDiagnosisLine,
    parseActionsJobParam,
    removeWatchedTarget,
    sameWatchedTarget,
    watchableTargets,
    watchedTargetsText,
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
    runnerMissingAppPermission,
    runnerModesFor,
    runnerReinstallAvailability,
    runnerReinstallDialog,
    runnerReinstallPlacement,
    runnerUpdateAvailable,
    RUNNER_DOCKER_SHIPPED,
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

    it('offers the container mode only on Linux hosts that advertise it, and only while the gate is on', () => {
        // P3 shipped it (FR-27): on by default; with the gate off it is never offered.
        expect(runnerModesFor('linux', ['service', 'docker'])).toEqual(['service', 'docker']);
        expect(runnerModesFor('linux', ['service', 'docker'], false)).toEqual(['service']);
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

/** Actions jobs (FL-18 P2, spec §5.4, FR-20 – FR-25, T-25) — the pure decisions behind the hub panel. */

const jobsMessages = (
    messages as unknown as { fleet: { runners: { diagnosis: Record<string, string> } } }
).fleet.runners.diagnosis;

function actionsJob(overrides: Partial<FleetActionsJobView> = {}): FleetActionsJobView {
    return {
        repository: 'acme/api',
        runId: 4822,
        runNumber: 4822,
        jobId: 1,
        name: 'e2e · windows',
        workflowName: 'CI',
        labels: ['self-hosted', 'windows'],
        status: 'queued',
        runnerName: null,
        startedAt: null,
        queuedAt: null,
        url: null,
        diagnosis: null,
        diagnosisDetail: null,
        unassignable: false,
        ...overrides,
    };
}

describe('Actions jobs — diagnosis (FR-22)', () => {
    it('says every diagnosis of the closed set in English, and only "waiting for" is not a problem', () => {
        for (const diagnosis of FLEET_ACTIONS_JOB_DIAGNOSES) {
            const line = jobDiagnosisLine(actionsJob({ diagnosis, diagnosisDetail: 'x' }));
            expect(line).not.toBeNull();
            expect(jobsMessages[line!.key]).toEqual(expect.any(String));
            expect(line!.problem).toBe(diagnosis !== 'all-busy');
        }
        expect(jobDiagnosisLine(actionsJob({ diagnosis: null }))).toBeNull();
    });

    it('names the label, the target and the runner waited for', () => {
        expect(
            jobDiagnosisLine(
                actionsJob({ diagnosis: 'missing-label', diagnosisDetail: 'windows' }),
            ),
        ).toEqual({
            key: 'missingLabel',
            values: { label: 'windows' },
            problem: true,
        });
        expect(
            jobDiagnosisLine(actionsJob({ diagnosis: 'wrong-scope', diagnosisDetail: null })),
        ).toEqual({
            key: 'wrongScope',
            values: { target: 'acme/api' },
            problem: true,
        });
        expect(
            jobDiagnosisLine(actionsJob({ diagnosis: 'all-busy', diagnosisDetail: 'build-01-2' })),
        ).toEqual({
            key: 'waitingFor',
            values: { runner: 'build-01-2' },
            problem: false,
        });
        expect(
            jobDiagnosisLine(actionsJob({ diagnosis: 'missing-label', diagnosisDetail: ' ' }))?.key,
        ).toBe('missingLabelUnnamed');
        expect(
            jobDiagnosisLine(actionsJob({ diagnosis: 'all-busy', diagnosisDetail: null }))?.key,
        ).toBe('waitingForAny');
    });
});

describe('Actions jobs — the panel', () => {
    it('counts queued and running jobs', () => {
        expect(
            jobCounts([
                actionsJob(),
                actionsJob({ status: 'in_progress' }),
                actionsJob({ jobId: 2 }),
            ]),
        ).toEqual({ queued: 2, running: 1 });
    });

    it('formats how long a job has waited or run', () => {
        const now = Date.parse('2026-10-27T10:00:00.000Z');
        expect(formatWaited('2026-10-27T09:53:30.000Z', now)).toBe('6 min');
        expect(formatWaited('2026-10-27T09:59:59.000Z', now)).toBe('1 min');
        expect(formatWaited('2026-10-27T07:00:00.000Z', now)).toBe('3 h');
        expect(formatWaited('2026-10-24T10:00:00.000Z', now)).toBe('3 d');
        expect(formatWaited(null, now)).toBeNull();
        expect(formatWaited('nope', now)).toBeNull();
    });

    it('shows no panel to someone with nothing to show', () => {
        const empty = {
            jobs: [],
            totalRunners: 0,
            watched: [],
            watchedSaved: false,
            unreadable: [],
        };
        expect(actionsJobsPanelHasContent(empty)).toBe(false);
        expect(actionsJobsPanelHasContent({ ...empty, totalRunners: 1 })).toBe(true);
        expect(actionsJobsPanelHasContent({ ...empty, watchedSaved: true })).toBe(true);
        expect(actionsJobsPanelHasContent({ ...empty, jobs: [actionsJob()] })).toBe(true);
    });

    it('confirms Cancel workflow run with the contracts’ sentence and sends confirm: true', () => {
        expect(cancelRunDialog(actionsJob())).toEqual({
            class: 'confirm',
            title: 'Cancel workflow run #4822 of acme/api?',
            body: 'Every job in it stops. This cannot be undone.',
        });
        expect(cancelRunDialog(actionsJob({ runNumber: null })).title).toBe(
            'Cancel workflow run of acme/api?',
        );
        expect(cancelRunRequest(actionsJob(), true)).toEqual({
            repository: 'acme/api',
            runId: 4822,
            runNumber: 4822,
            confirm: true,
        });
        expect(cancelRunRequest(actionsJob({ runNumber: null }), false)).toEqual({
            repository: 'acme/api',
            runId: 4822,
        });
    });

    it('reads the needs-a-look item’s ?actionsJob= value and matches its run', () => {
        const value = actionsJobParamValue('acme/api', 4822);
        expect(value).toBe('acme/api#4822');
        // The producer writes it with encodeURIComponent; URLSearchParams decodes it.
        const read = new URLSearchParams(`actionsJob=${encodeURIComponent(value)}`).get(
            ACTIONS_JOB_PARAM,
        );
        const parsed = parseActionsJobParam(read);
        expect(parsed).toEqual({ repository: 'acme/api', runId: 4822 });
        expect(isHighlightedJob(actionsJob({ repository: 'ACME/api' }), parsed)).toBe(true);
        expect(isHighlightedJob(actionsJob({ runId: 1 }), parsed)).toBe(false);
        expect(isHighlightedJob(actionsJob(), null)).toBe(false);
        for (const bad of [
            null,
            '',
            'acme/api',
            '#4822',
            'acme/api#',
            'acme/api#x',
            'not a repo#1',
            'acme/api#0',
        ]) {
            expect(parseActionsJobParam(bad)).toBeNull();
        }
    });

    it('opens the hub at the panel from the palette', () => {
        expect(actionsJobsHref()).toBe(`/fleet#${ACTIONS_JOBS_ANCHOR}`);
    });

    it('keys a row by repository, run and job', () => {
        expect(actionsJobKey(actionsJob({ repository: 'Acme/Api', jobId: 9 }))).toBe(
            'acme/api#4822:9',
        );
    });
});

describe('Actions jobs — the watched list (FR-21)', () => {
    const api = { scope: 'repo' as const, target: 'acme/api' };
    const web = { scope: 'repo' as const, target: 'acme/web' };
    const org = { scope: 'org' as const, target: 'acme' };

    it('adds once (case-insensitively) and removes', () => {
        expect(addWatchedTarget([api], { scope: 'repo', target: 'ACME/API' })).toEqual([api]);
        expect(addWatchedTarget([api], web)).toEqual([api, web]);
        expect(removeWatchedTarget([api, web], { scope: 'repo', target: 'Acme/Web' })).toEqual([
            api,
        ]);
        expect(sameWatchedTarget(org, { scope: 'repo', target: 'acme' })).toBe(false);
    });

    it('stops at the most a person may watch', () => {
        const full = Array.from({ length: FLEET_ACTIONS_MAX_WATCHED_TARGETS }, (_, index) => ({
            scope: 'repo' as const,
            target: `acme/r${index}`,
        }));
        expect(addWatchedTarget(full, web)).toHaveLength(FLEET_ACTIONS_MAX_WATCHED_TARGETS);
    });

    it('offers what the App covers and is not watched yet, repositories first', () => {
        expect(watchableTargets([org, api, web], [api])).toEqual([web, org]);
    });

    it('names the watched list', () => {
        expect(watchedTargetsText([api, web])).toBe('acme/api, acme/web');
        expect(watchedTargetsText([])).toBe('');
    });
});

/** Container-isolated runners and versions (FL-18 P3, spec FR-27, FR-28, T-27, T-28). */
describe('P3 — the container mode (FR-27)', () => {
    it('is shipped, offered on Linux only when the server lists it, never on Windows or macOS', () => {
        expect(RUNNER_DOCKER_SHIPPED).toBe(true);
        expect(runnerModesFor('linux', ['service', 'docker'])).toEqual(['service', 'docker']);
        expect(runnerModesFor('linux', ['service'])).toEqual(['service']);
        expect(runnerModesFor('win32', ['service', 'docker'])).toEqual(['service']);
        expect(runnerModesFor('windows', ['service', 'docker'])).toEqual(['service']);
        expect(runnerModesFor('darwin', ['service', 'docker'])).toEqual(['service']);
    });

    it('sends the daemon opt-in only with the container mode, exactly as ticked', () => {
        const base = {
            targetKey: 'repo:acme/api',
            count: 1,
            names: ['build-01-1'],
            labelsText: '',
        };
        expect(installRequestFrom({ ...base, mode: 'docker' }, target(), [])).toMatchObject({
            mode: 'docker',
            shareDockerDaemon: false,
        });
        expect(
            installRequestFrom({ ...base, mode: 'docker', shareDockerDaemon: true }, target(), []),
        ).toMatchObject({ mode: 'docker', shareDockerDaemon: true });
        expect(
            installRequestFrom({ ...base, mode: 'service', shareDockerDaemon: true }, target(), []),
        ).not.toHaveProperty('shareDockerDaemon');
    });
});

describe('P3 — versions and Reinstall (FR-28)', () => {
    it('shows "Update available" only for a newer build', () => {
        expect(
            runnerUpdateAvailable(runner({ runnerVersion: '2.321.0', updateAvailable: '2.322.0' })),
        ).toBe('2.322.0');
        expect(
            runnerUpdateAvailable(runner({ runnerVersion: '2.322.0', updateAvailable: '2.322.0' })),
        ).toBeNull();
        expect(
            runnerUpdateAvailable(runner({ runnerVersion: '2.330.0', updateAvailable: '2.322.0' })),
        ).toBeNull();
        expect(
            runnerUpdateAvailable(runner({ runnerVersion: '2.321.0', updateAvailable: null })),
        ).toBeNull();
        expect(runnerUpdateAvailable(runner({ runnerVersion: '2.321.0' }))).toBeNull();
        // The installed version unknown: the API's word stands.
        expect(
            runnerUpdateAvailable(runner({ runnerVersion: null, updateAvailable: '2.322.0' })),
        ).toBe('2.322.0');
    });

    it('offers Reinstall for idle, offline, stopped and failed runners only', () => {
        const offered = FLEET_ACTIONS_RUNNER_STATES.filter(
            (state) => runnerReinstallAvailability(runner({ state })) === 'enabled',
        );
        expect(offered).toEqual(['idle', 'offline', 'stopped', 'failed']);
        expect(runnerReinstallAvailability(runner({ state: 'idle', phase: 'removing' }))).toBe(
            'hidden',
        );
        expect(runnerReinstallAvailability(runner({ state: 'working' }))).toBe('hidden');
        expect(
            runnerReinstallAvailability(runner({ state: 'installing', phase: 'verifying' })),
        ).toBe('hidden');
    });

    it('is the failed row’s Retry, in the row when an update is available, else in the ⋯ menu', () => {
        expect(runnerReinstallPlacement(runner({ state: 'failed' }))).toBe('retry');
        expect(
            runnerReinstallPlacement(
                runner({ state: 'idle', runnerVersion: '2.321.0', updateAvailable: '2.322.0' }),
            ),
        ).toBe('inline');
        expect(runnerReinstallPlacement(runner({ state: 'idle' }))).toBe('menu');
    });

    it('confirms Reinstall with the contracts’ sentence, naming the newer build', () => {
        expect(
            runnerReinstallDialog(runner({ runnerVersion: '2.321.0', updateAvailable: '2.322.0' })),
        ).toEqual({
            class: 'confirm',
            title: 'Reinstall build-01-1 with runner 2.322.0?',
            body: 'It is deregistered, downloaded again, verified and registered with the same name and labels.',
        });
        expect(runnerReinstallDialog(runner({ updateAvailable: null })).title).toBe(
            'Reinstall build-01-1?',
        );
    });
});

/** FL-18 A16 (owner decision 2026-10-27) — a failed runner names the App permission to accept. */
describe('runnerMissingAppPermission', () => {
    const failed = (lastError: string | null, state: 'failed' | 'idle' = 'failed') => ({
        state,
        lastError,
    });

    it('reads the repository permission out of the facade refusal the node recorded', () => {
        expect(
            runnerMissingAppPermission(
                failed(
                    'the registration token could not be fetched: the Ever Works GitHub App on acme needs "Administration: Read and write"',
                ),
            ),
        ).toBe('Administration: Read and write');
    });

    it('reads the organisation permission, with typographic quotes too', () => {
        expect(
            runnerMissingAppPermission(
                failed(
                    'the Ever Works GitHub App on acme needs “Self-hosted runners: Read and write”',
                ),
            ),
        ).toBe('Self-hosted runners: Read and write');
    });

    it('answers null for any other failure, a runner that did not fail, or no error', () => {
        expect(
            runnerMissingAppPermission(failed('checksum mismatch for actions-runner.tar.gz')),
        ).toBeNull();
        expect(
            runnerMissingAppPermission(failed('something needs "Administration: Read and write"')),
        ).toBeNull();
        expect(
            runnerMissingAppPermission(
                failed(
                    'the Ever Works GitHub App on acme needs "Administration: Read and write"',
                    'idle',
                ),
            ),
        ).toBeNull();
        expect(runnerMissingAppPermission(failed(null))).toBeNull();
    });
});
