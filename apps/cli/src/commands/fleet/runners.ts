import { Command } from 'commander';
import chalk from 'chalk';
import {
    clampFleetActionsRunnerCount,
    isFleetActionsRunnerLabel,
    isFleetActionsRunnerName,
    isFleetActionsRunnerTarget,
    type FleetActionsJobsView,
    type FleetActionsRunnersListView,
    type FleetConfirmArgs,
} from '@ever-works/contracts';
import { fleetRequest, resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { fleetConfirmFields, type FleetConfirmFlags } from './fleet-confirm';
import { emitFleetError, fleetTable, fleetUsage, readFleetCliError } from './fleet-output';

/**
 * Actions runners from a shell (FL-18 P3, T-29, CONTRACTS §11.3) — the
 * `runners` family over the same routes the web uses, with the names the fleet
 * tool catalogue gives them:
 *
 *   ever-works fleet runners list [--on <computer>]
 *   ever-works fleet runners jobs [--targets acme/api,acme]
 *   ever-works fleet runners install <computer> --repo owner/name | --org login [--count n] [--names a,b] [--labels x,y] [--yes]
 *   ever-works fleet runners start|stop|restart <computer> <runner> [--yes]
 *   ever-works fleet runners reinstall <computer> <runner> [--yes]
 *   ever-works fleet runners remove <computer> <runner> --confirm-name <name>
 *   ever-works fleet runners cancel-run <owner/repo> <runId> [--run-number n] [--yes]
 *
 * `<computer>` is its id or name, `<runner>` the runner's id or name on it.
 * Every verb takes `--json` (`{ ok, data }`) and exits `0 / 1 / 2`; a missing
 * confirmation exits 2 with the summary (asked on a terminal).
 */

type Flags = FleetConfirmFlags & { json?: boolean };

function confirmOf(flags: Flags): FleetConfirmArgs {
    return fleetConfirmFields({ yes: flags.yes, confirmName: flags.confirmName });
}

function withConfirm(command: Command, destructive = false): Command {
    command.option('--yes', 'Confirm (class confirm)').option('--json', 'Machine-readable output');
    if (destructive)
        command.option(
            '--confirm-name <name>',
            "Type the runner's exact name (class confirm-destructive)",
        );
    return command;
}

function accepted(label: string): (data: unknown) => void {
    return (data) => {
        const value = (data ?? {}) as { operationId?: string; jobId?: string };
        console.log(chalk.green(`✓ ${label}`));
        const id = value.operationId ?? value.jobId;
        if (id)
            console.log(
                chalk.gray(`Running as job ${id}; watch it with: ever-works fleet runners list`),
            );
    };
}

function csv(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** A runner on a computer, by id or by name. */
async function resolveRunner(
    json: boolean,
    nodeId: string,
    ref: string,
): Promise<{ id: string; name: string }> {
    let list: FleetActionsRunnersListView;
    try {
        list = await fleetRequest<FleetActionsRunnersListView>({
            method: 'GET',
            path: `/fleet/nodes/${nodeId}/runners`,
        });
    } catch (error) {
        return emitFleetError(json, readFleetCliError(error));
    }
    const wanted = ref.toLowerCase();
    const match = list.runners.find(
        (runner) => runner.id === ref || runner.name.toLowerCase() === wanted,
    );
    if (!match) {
        return emitFleetError(json, {
            code: 'not_found',
            hint: `no Actions runner ${ref} on ${list.node?.name ?? 'that computer'}`,
            details: { field: 'runner' },
        });
    }
    return { id: match.id, name: match.name };
}

/** The runners table (`fleet runners list`), header first. */
export function fleetRunnerRows(views: readonly FleetActionsRunnersListView[]): string[][] {
    const rows = [['ID', 'NAME', 'COMPUTER', 'TARGET', 'STATE', 'MODE', 'VERSION', 'LABELS']];
    for (const view of views) {
        for (const runner of view.runners) {
            const state =
                runner.state === 'stopped' && runner.stoppedByOwner
                    ? 'stopped (by you)'
                    : runner.state === 'installing' && runner.phase
                      ? `installing · ${runner.phase}`
                      : runner.state;
            const version = runner.updateAvailable
                ? `${runner.runnerVersion ?? '—'} (update ${runner.updateAvailable})`
                : (runner.runnerVersion ?? '—');
            rows.push([
                runner.id,
                runner.name,
                view.node.name,
                runner.target,
                state,
                runner.mode === 'docker' ? 'container' : runner.mode,
                version,
                [...runner.defaultLabels, ...runner.labels].join(','),
            ]);
        }
    }
    return rows;
}

function printRunners(views: readonly FleetActionsRunnersListView[]): void {
    const rows = fleetRunnerRows(views);
    console.log(rows.length === 1 ? chalk.yellow('No Actions runners.') : fleetTable(rows));
}

/** The jobs table (`fleet runners jobs`), header first: the runner, or why none takes a queued job. */
export function fleetActionsJobRows(data: FleetActionsJobsView): string[][] {
    const rows = [['REPOSITORY', 'RUN', 'JOB', 'STATUS', 'RUNNER / WHY']];
    for (const job of data.jobs) {
        rows.push([
            job.repository,
            job.runNumber ? `#${job.runNumber} (${job.runId})` : String(job.runId),
            job.name,
            job.status === 'queued'
                ? job.unassignable
                    ? 'queued — needs a look'
                    : 'queued'
                : 'in progress',
            job.status === 'in_progress'
                ? (job.runnerName ?? '—')
                : job.diagnosis
                  ? `${job.diagnosis}${job.diagnosisDetail ? `: ${job.diagnosisDetail}` : ''}`
                  : 'a runner can take it',
        ]);
    }
    return rows;
}

const list = new Command('list')
    .description('The Actions runners on one computer, or on every computer you may see')
    .option('--on <computer>', 'Only this computer (id or name)')
    .option('--json', 'Machine-readable output')
    .action(async (flags: Flags & { on?: string }) => {
        const json = flags.json === true;
        const path = flags.on
            ? `/fleet/nodes/${await resolveFleetNodeId(json, flags.on)}/runners`
            : '/fleet/runners';
        await runFleetVerb<unknown>(json, { method: 'GET', path }, (data) => {
            printRunners(
                flags.on
                    ? [data as FleetActionsRunnersListView]
                    : ((data as { computers?: FleetActionsRunnersListView[] }).computers ?? []),
            );
        });
    });

const jobs = new Command('jobs')
    .description(
        'Queued and running Actions jobs of the watched repositories and organisations, with why no runner takes them',
    )
    .option(
        '--targets <list>',
        'Comma-separated owner/repo or organisation names instead of the watched list',
    )
    .option('--json', 'Machine-readable output')
    .action(async (flags: Flags & { targets?: string }) => {
        const json = flags.json === true;
        const targets = csv(flags.targets);
        await runFleetVerb<FleetActionsJobsView>(
            json,
            {
                method: 'GET',
                path: '/fleet/runners/jobs',
                query: targets.length > 0 ? { targets: targets.join(',') } : {},
            },
            (data) => {
                console.log(
                    chalk.gray(
                        `${data.busyRunners} of ${data.totalRunners} runners busy · watching ${data.watched.map((t) => t.target).join(', ') || '—'}`,
                    ),
                );
                const rows = fleetActionsJobRows(data);
                console.log(
                    rows.length === 1
                        ? chalk.yellow('No queued or running jobs on your runners.')
                        : fleetTable(rows),
                );
                for (const entry of data.unreadable) {
                    console.log(
                        chalk.yellow(
                            `! ${entry.target}: ${entry.reason}${entry.grantUrl ? ` — grant access: ${entry.grantUrl}` : ''}`,
                        ),
                    );
                }
                if (data.rateLimitedUntil)
                    console.log(
                        chalk.yellow(
                            `GitHub is rate-limiting; next check ${data.rateLimitedUntil}`,
                        ),
                    );
            },
        );
    });

const install = withConfirm(
    new Command('install')
        .description(
            'Install 1–16 Actions runners on a computer for a repository or organisation your GitHub App covers',
        )
        .argument('<computer>', 'The computer (id or name)')
        .option('--repo <owner/name>', 'Register for this repository')
        .option('--org <login>', 'Register for this organisation')
        .option('--count <n>', '1–16 (default 1)')
        .option('--names <list>', 'Comma-separated names, one per runner (default <computer>-<n>)')
        .option(
            '--labels <list>',
            'Comma-separated extra labels (GitHub adds self-hosted, the OS and the architecture)',
        ),
).action(
    async (
        ref: string,
        flags: Flags & {
            repo?: string;
            org?: string;
            count?: string;
            names?: string;
            labels?: string;
        },
    ) => {
        const json = flags.json === true;
        if (Boolean(flags.repo) === Boolean(flags.org))
            fleetUsage(json, 'give exactly one of --repo or --org', 'target');
        const scope = flags.repo ? 'repo' : 'org';
        const target = (flags.repo ?? flags.org ?? '').trim();
        if (!isFleetActionsRunnerTarget(scope, target)) {
            fleetUsage(
                json,
                scope === 'repo' ? '--repo is owner/name' : '--org is an organisation login',
                'target',
            );
        }
        const count = flags.count === undefined ? 1 : Number(flags.count);
        if (!Number.isInteger(count) || count < 1 || count > 16)
            fleetUsage(json, '--count is 1 to 16', 'count');
        const names = csv(flags.names);
        if (
            names.length > 0 &&
            (names.length !== count || names.some((name) => !isFleetActionsRunnerName(name)))
        ) {
            fleetUsage(
                json,
                `--names needs ${count} runner names (letters, digits, dots, dashes, underscores)`,
                'names',
            );
        }
        const labels = csv(flags.labels);
        if (labels.some((label) => !isFleetActionsRunnerLabel(label)))
            fleetUsage(json, '--labels has a label that is not valid', 'labels');
        const nodeId = await resolveFleetNodeId(json, ref);
        await runFleetVerb(
            json,
            {
                method: 'POST',
                path: `/fleet/nodes/${nodeId}/runners`,
                body: {
                    target: { scope, target },
                    count: clampFleetActionsRunnerCount(count),
                    ...(names.length > 0 ? { names } : {}),
                    ...(labels.length > 0 ? { labels } : {}),
                },
            },
            accepted(`installing ${count} runner${count === 1 ? '' : 's'} for ${target}`),
            confirmOf(flags),
        );
    },
);

function controlCommand(action: 'start' | 'stop' | 'restart' | 'reinstall'): Command {
    const what: Record<typeof action, string> = {
        start: 'Start an Actions runner',
        stop: 'Stop an Actions runner (asks first; a job in progress finishes)',
        restart: 'Restart an Actions runner’s service (asks first)',
        reinstall: 'Reinstall an Actions runner with GitHub’s latest build (asks first)',
    };
    return withConfirm(
        new Command(action)
            .description(what[action])
            .argument('<computer>', 'The computer (id or name)')
            .argument('<runner>', 'The runner (id or name)'),
    ).action(async (computer: string, ref: string, flags: Flags) => {
        const json = flags.json === true;
        const nodeId = await resolveFleetNodeId(json, computer);
        const runner = await resolveRunner(json, nodeId, ref);
        await runFleetVerb(
            json,
            {
                method: 'POST',
                path: `/fleet/nodes/${nodeId}/runners/${runner.id}/${action}`,
                body: {},
            },
            accepted(
                `${action === 'stop' ? 'stopping' : action === 'start' ? 'starting' : `${action}ing`} ${runner.name}`,
            ),
            confirmOf(flags),
        );
    });
}

const remove = withConfirm(
    new Command('remove')
        .description(
            'Remove an Actions runner: deregister it at GitHub, uninstall its service and delete its folder',
        )
        .argument('<computer>', 'The computer (id or name)')
        .argument('<runner>', 'The runner (id or name)'),
    true,
).action(async (computer: string, ref: string, flags: Flags) => {
    const json = flags.json === true;
    const nodeId = await resolveFleetNodeId(json, computer);
    const runner = await resolveRunner(json, nodeId, ref);
    await runFleetVerb(
        json,
        { method: 'POST', path: `/fleet/nodes/${nodeId}/runners/${runner.id}/remove`, body: {} },
        accepted(`removing ${runner.name}`),
        confirmOf(flags),
    );
});

const cancelRun = withConfirm(
    new Command('cancel-run')
        .description(
            'Cancel a whole workflow run of one of your repositories (every job in it stops)',
        )
        .argument('<repository>', 'owner/name')
        .argument('<runId>', 'The workflow run id (from `fleet runners jobs`)')
        .option('--run-number <n>', 'The run number, for the confirmation sentence'),
).action(async (repository: string, rawRunId: string, flags: Flags & { runNumber?: string }) => {
    const json = flags.json === true;
    if (!isFleetActionsRunnerTarget('repo', repository))
        fleetUsage(json, '<repository> is owner/name', 'repository');
    const runId = Number(rawRunId);
    if (!Number.isSafeInteger(runId) || runId <= 0)
        fleetUsage(json, '<runId> is a workflow run id', 'runId');
    const runNumber = flags.runNumber === undefined ? undefined : Number(flags.runNumber);
    await runFleetVerb(
        json,
        {
            method: 'POST',
            path: '/fleet/runners/jobs/cancel',
            body: {
                repository,
                runId,
                ...(runNumber && Number.isSafeInteger(runNumber) ? { runNumber } : {}),
            },
        },
        accepted(`cancelling workflow run ${runId} of ${repository}`),
        confirmOf(flags),
    );
});

export const runnersCommand = new Command('runners')
    .description(
        'GitHub Actions runners on your computers: list, jobs, install, start, stop, restart, reinstall, remove, cancel-run',
    )
    .addCommand(list)
    .addCommand(jobs)
    .addCommand(install)
    .addCommand(controlCommand('start'))
    .addCommand(controlCommand('stop'))
    .addCommand(controlCommand('restart'))
    .addCommand(controlCommand('reinstall'))
    .addCommand(remove)
    .addCommand(cancelRun);
