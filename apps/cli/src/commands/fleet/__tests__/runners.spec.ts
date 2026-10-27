import { describe, expect, it } from 'vitest';
import type { FleetActionsJobsView, FleetActionsRunnersListView } from '@ever-works/contracts';
import { fleetActionsJobRows, fleetRunnerRows, runnersCommand } from '../runners';

/** FL-18 T-29 — `ever-works fleet runners …`: the verbs, and the tables drawn from the API's own objects. */

const list: FleetActionsRunnersListView = {
    node: { id: 'n1', name: 'build-01' },
    checkedAt: null,
    rateLimitedUntil: null,
    killSwitch: false,
    runners: [
        {
            id: 'r1',
            nodeId: 'n1',
            name: 'build-01-1',
            scope: 'repo',
            target: 'acme/api',
            labels: ['gpu'],
            defaultLabels: ['self-hosted', 'Linux', 'X64'],
            mode: 'docker',
            state: 'stopped',
            stateSource: 'github',
            stoppedByOwner: true,
            phase: null,
            lastError: null,
            githubRunnerId: 42,
            runnerVersion: '2.321.0',
            updateAvailable: '2.322.0',
            currentJob: null,
            lastSeenAt: null,
            lastCheckAt: null,
            installedAt: null,
            githubUrl: 'https://github.com/acme/api/settings/actions/runners',
            logSource: 'runner:build-01-1',
        },
    ],
};

describe('fleet runners', () => {
    it('offers every verb of the catalogue rows', () => {
        expect(runnersCommand.commands.map((command) => command.name())).toEqual([
            'list',
            'jobs',
            'install',
            'start',
            'stop',
            'restart',
            'reinstall',
            'remove',
            'cancel-run',
        ]);
    });

    it('draws the runners table: stopped (by you), container mode, the update available, all labels', () => {
        expect(fleetRunnerRows([list])).toEqual([
            ['ID', 'NAME', 'COMPUTER', 'TARGET', 'STATE', 'MODE', 'VERSION', 'LABELS'],
            [
                'r1',
                'build-01-1',
                'build-01',
                'acme/api',
                'stopped (by you)',
                'container',
                '2.321.0 (update 2.322.0)',
                'self-hosted,Linux,X64,gpu',
            ],
        ]);
    });

    it('draws the jobs table with the runner or the reason none takes it', () => {
        const view = {
            jobs: [
                {
                    repository: 'acme/api',
                    runId: 4822,
                    runNumber: 17,
                    jobId: 1,
                    name: 'e2e · windows',
                    workflowName: 'CI',
                    labels: ['self-hosted', 'windows'],
                    status: 'queued',
                    runnerName: null,
                    startedAt: null,
                    queuedAt: null,
                    url: null,
                    diagnosis: 'missing-label',
                    diagnosisDetail: 'windows',
                    unassignable: true,
                },
                {
                    repository: 'acme/api',
                    runId: 4823,
                    runNumber: null,
                    jobId: 2,
                    name: 'test',
                    workflowName: null,
                    labels: [],
                    status: 'in_progress',
                    runnerName: 'build-01-2',
                    startedAt: null,
                    queuedAt: null,
                    url: null,
                    diagnosis: null,
                    diagnosisDetail: null,
                    unassignable: false,
                },
            ],
        } as unknown as FleetActionsJobsView;
        expect(fleetActionsJobRows(view).slice(1)).toEqual([
            [
                'acme/api',
                '#17 (4822)',
                'e2e · windows',
                'queued — needs a look',
                'missing-label: windows',
            ],
            ['acme/api', '4823', 'test', 'in progress', 'build-01-2'],
        ]);
    });
});
