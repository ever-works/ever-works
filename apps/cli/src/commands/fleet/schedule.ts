import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'readline';
import {
    describeFleetScheduleSkip,
    fleetNodeScheduleRowId,
    fleetScheduleCadenceFromForm,
    formatFleetScheduleInstant,
    type FleetCommandRunView,
    type FleetScheduleCadence,
    type FleetScheduleCadenceForm,
    type FleetScheduleConfirmationDetails,
    type FleetScheduleView,
} from '@ever-works/contracts';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { resolveNodeTokens, type FleetNodeRef } from './command-output';

/**
 * Schedules on computers (FL-13, spec S8, FR-31, CONTRACTS §11.3) —
 * `ever-works fleet schedules create|list|get|update|run|pause|resume|runs|delete`
 * (alias `fleet schedule`).
 *
 * The same routes and shapes as the web: a schedule is a Command with a
 * cadence (`POST /api/fleet/commands` with `cadence` + `name`, `PATCH` /
 * `DELETE /api/fleet/commands/:id`, `/commands/:id/runs`); Run now, Pause and
 * Resume ride the Schedules routes (`/api/schedules/node_schedule:<id>/…`).
 * A write that needs a confirmation prints the platform's summary and asks
 * (or `--yes`). `--json` prints the web's shapes. Exit codes: `0` ok · `1`
 * refused or failed · `2` usage.
 */

export const FLEET_SCHEDULE_CLI_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

interface ErrorBody {
    error?: { code?: string; hint?: string; details?: Record<string, unknown> };
    message?: string;
}

function readError(error: unknown): {
    status: number;
    code: string;
    hint: string;
    details: Record<string, unknown>;
} {
    const response = (error as { response?: { status?: number; data?: ErrorBody } })?.response;
    const body = response?.data?.error;
    return {
        status: response?.status ?? 0,
        code: typeof body?.code === 'string' ? body.code : 'internal',
        hint:
            typeof body?.hint === 'string'
                ? body.hint
                : typeof response?.data?.message === 'string'
                  ? response.data.message
                  : error instanceof Error
                    ? error.message
                    : 'the request failed',
        details: body?.details && typeof body.details === 'object' ? body.details : {},
    };
}

function fail(message: string, code: number = FLEET_SCHEDULE_CLI_EXIT.usage): never {
    console.error(chalk.red(`Error: ${message}`));
    process.exit(code);
}

async function askYes(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The cadence the flags describe: `--every 30m|1h`, `--at HH:MM` [`--days mon,wed` | `--weekdays`], or `--cron`. */
export function cadenceFromFlags(options: {
    every?: string;
    at?: string;
    days?: string;
    weekdays?: boolean;
    cron?: string;
}): { cadence: FleetScheduleCadence | null; error: string | null } {
    let form: FleetScheduleCadenceForm | null = null;
    if (options.cron) form = { form: 'cron', expr: options.cron };
    else if (options.every) {
        const match = /^(\d+)\s*(m|min|minutes?|h|hours?)?$/i.exec(options.every.trim());
        if (!match) return { cadence: null, error: '--every takes minutes like 30m, or 1h' };
        const value = Number(match[1]);
        const hours = /^h/i.test(match[2] ?? '');
        if (hours && value === 1) form = { form: 'hourly' };
        else if (hours)
            return {
                cadence: null,
                error: 'every N hours is a --cron (e.g. --cron "0 */2 * * *")',
            };
        else form = value >= 60 ? { form: 'hourly' } : { form: 'every', minutes: value };
    } else if (options.at) {
        if (options.days) {
            const days = options.days
                .split(',')
                .map((day) => DAY_NAMES.indexOf(day.trim().toLowerCase().slice(0, 3)))
                .filter((day) => day >= 0);
            form = { form: 'days', days, at: options.at };
        } else if (options.weekdays) form = { form: 'weekdays', at: options.at };
        else form = { form: 'daily', at: options.at };
    }
    if (!form)
        return {
            cadence: null,
            error: 'say when: --every 30m, --at 02:00 [--weekdays | --days mon,wed], or --cron "…"',
        };
    return fleetScheduleCadenceFromForm(form);
}

async function listNodes(): Promise<FleetNodeRef[]> {
    try {
        const { data } = await getHttpClient().get<Array<{ id: string; name: string }>>(
            '/fleet/nodes?scope=visible',
        );
        return (Array.isArray(data) ? data : []).map((node) => ({ id: node.id, name: node.name }));
    } catch (error) {
        return fail(
            `could not list your computers: ${readError(error).hint}`,
            FLEET_SCHEDULE_CLI_EXIT.failed,
        );
    }
}

async function oneNode(token: string): Promise<FleetNodeRef> {
    const nodes = await listNodes();
    const resolved = resolveNodeTokens(token, nodes);
    if (resolved.unknown.length > 0) fail(`no computer named ${resolved.unknown.join(', ')}`);
    if (resolved.ambiguous.length > 0)
        fail(`more than one computer is named ${resolved.ambiguous.join(', ')}; use its id`);
    if (resolved.ids.length !== 1) fail('--on names exactly one computer');
    return (
        nodes.find((node) => node.id === resolved.ids[0]) ?? {
            id: resolved.ids[0],
            name: resolved.ids[0],
        }
    );
}

function printSchedule(schedule: FleetScheduleView): void {
    const glyph = schedule.neverRuns ? '⚠' : !schedule.enabled ? '⏸' : schedule.running ? '◐' : '●';
    const next = schedule.nextRunAt
        ? `next ${formatFleetScheduleInstant(Date.parse(schedule.nextRunAt), schedule.nodeTimeZone)}`
        : schedule.neverRuns
          ? schedule.neverRuns.hint
          : !schedule.enabled
            ? `paused${schedule.pausedReason === 'failures' ? ' after 5 failures in a row' : ''}`
            : 'no fire scheduled';
    const last = schedule.lastRun ? ` · last ${schedule.lastRun.status}` : '';
    const sync =
        schedule.syncState === 'pending'
            ? chalk.gray(` · will sync when ${schedule.nodeName ?? 'the computer'} is back`)
            : '';
    console.log(
        `${glyph} ${chalk.bold(schedule.name)} ${chalk.gray(schedule.id)}\n    ${chalk.cyan(schedule.nodeName ?? 'removed computer')} · ${schedule.cadenceHuman} · ${next}${last}${sync}\n    $ ${schedule.command}`,
    );
}

function printConfirmation(details: FleetScheduleConfirmationDetails): void {
    console.log(chalk.bold(`${details.name} on ${details.nodeName}`));
    console.log(`  $ ${details.command}`);
    console.log(`  ${details.shell} as the machine owner, from ${details.folder}, no input`);
    console.log(
        `  ${details.cadenceHuman} on ${details.nodeName}'s clock${details.nodeTimeZone ? ` (${details.nodeTimeZone})` : ''}`,
    );
    if (details.next.length > 0) {
        console.log(
            `  next: ${details.next.map((at) => formatFleetScheduleInstant(Date.parse(at), details.nodeTimeZone)).join(' · ')}`,
        );
    }
    if (typeof details.runCount === 'number')
        console.log(`  ${details.runCount} run(s) stay readable for 30 days`);
    console.log(chalk.yellow(`  ⚠ ${details.sentence}`));
}

/** Send a write; on 409 `confirmation_required` print it, confirm, and send it again with `confirm: true`. */
async function withConfirmation<T>(
    send: (confirm: boolean) => Promise<T>,
    options: { yes?: boolean; json?: boolean },
): Promise<T> {
    try {
        return await send(false);
    } catch (error) {
        const read = readError(error);
        if (read.code !== 'confirmation_required') {
            return fail(
                `${read.code}: ${read.hint}`,
                read.status === 400
                    ? FLEET_SCHEDULE_CLI_EXIT.usage
                    : FLEET_SCHEDULE_CLI_EXIT.failed,
            );
        }
        const details = read.details as unknown as FleetScheduleConfirmationDetails;
        if (!options.json) printConfirmation(details);
        if (!options.yes) {
            if (!process.stdin.isTTY) fail('pass --yes to go ahead without a prompt');
            if (!(await askYes('Go ahead? [y/N] ')))
                fail('nothing was changed', FLEET_SCHEDULE_CLI_EXIT.failed);
        }
        try {
            return await send(true);
        } catch (again) {
            const second = readError(again);
            return fail(`${second.code}: ${second.hint}`, FLEET_SCHEDULE_CLI_EXIT.failed);
        }
    }
}

async function fetchSchedules(nodeId?: string): Promise<FleetScheduleView[]> {
    const http = getHttpClient();
    const out: FleetScheduleView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
        const query = new URLSearchParams({ sourceType: 'node_schedule', limit: '50' });
        if (nodeId) query.set('node', nodeId);
        if (cursor) query.set('cursor', cursor);
        const { data } = await http.get<{
            items?: Array<{ nodeSchedule?: FleetScheduleView }>;
            nextCursor?: string | null;
        }>(`/schedules/page?${query.toString()}`);
        for (const item of data?.items ?? []) if (item.nodeSchedule) out.push(item.nodeSchedule);
        cursor = data?.nextCursor ?? null;
        if (!cursor) break;
    }
    return out;
}

const createCommand = new Command('create')
    .description('Schedule a command on one computer, on its own clock')
    .requiredOption('--on <computer>', 'The computer (name or id)')
    .requiredOption('--name <name>', 'The schedule name')
    .requiredOption(
        '--command <command>',
        "The command line, run in the machine owner's login shell",
    )
    .option('--folder <dir>', "Folder to run it in (default the machine owner's home)")
    .option('--every <interval>', 'Every N minutes (30m) or hourly (1h)')
    .option('--at <HH:MM>', "Daily at this time on the computer's clock")
    .option('--weekdays', 'With --at: Monday to Friday')
    .option('--days <days>', 'With --at: on these days (mon,wed,fri)')
    .option('--cron <expr>', 'A five-field cron expression')
    .option('--json', 'Print the schedule as JSON')
    .option('-y, --yes', 'Skip the confirmation (it is still printed)')
    .action(
        async (options: {
            on: string;
            name: string;
            command: string;
            folder?: string;
            every?: string;
            at?: string;
            weekdays?: boolean;
            days?: string;
            cron?: string;
            json?: boolean;
            yes?: boolean;
        }) => {
            const built = cadenceFromFlags(options);
            if (!built.cadence) fail(built.error ?? 'say when it runs');
            await requireAuth();
            const node = await oneNode(options.on);
            const http = getHttpClient();
            const created = await withConfirmation(
                async (confirm) =>
                    (
                        await http.post<FleetScheduleView>('/fleet/commands', {
                            name: options.name,
                            nodeId: node.id,
                            nodeIds: [node.id],
                            command: options.command,
                            ...(options.folder ? { cwd: options.folder } : {}),
                            cadence: built.cadence,
                            ...(confirm ? { confirm: true } : {}),
                        })
                    ).data,
                options,
            );
            if (options.json) console.log(JSON.stringify(created));
            else printSchedule(created);
            process.exit(FLEET_SCHEDULE_CLI_EXIT.ok);
        },
    );

const listSchedulesCommand = new Command('list')
    .description('Your schedules on computers')
    .option('--on <computer>', 'Only this computer')
    .option('--json', 'Print one JSON object per schedule')
    .action(async (options: { on?: string; json?: boolean }) => {
        await requireAuth();
        const node = options.on ? await oneNode(options.on) : null;
        let schedules: FleetScheduleView[] = [];
        try {
            schedules = await fetchSchedules(node?.id);
        } catch (error) {
            const read = readError(error);
            fail(`${read.code}: ${read.hint}`, FLEET_SCHEDULE_CLI_EXIT.failed);
        }
        if (options.json) {
            for (const schedule of schedules) console.log(JSON.stringify(schedule));
        } else if (schedules.length === 0) {
            console.log(
                node ? `Nothing is scheduled on ${node.name}.` : 'No schedules on your computers.',
            );
        } else {
            for (const schedule of schedules) printSchedule(schedule);
        }
        process.exit(FLEET_SCHEDULE_CLI_EXIT.ok);
    });

const getScheduleCommand = new Command('get')
    .description('One schedule')
    .argument('<id>', 'The schedule id')
    .option('--json', 'Print it as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
        await requireAuth();
        try {
            const { data } = await getHttpClient().get<FleetScheduleView>(
                `/fleet/commands/${encodeURIComponent(id)}`,
            );
            if (options.json) console.log(JSON.stringify(data));
            else printSchedule(data);
            process.exit(FLEET_SCHEDULE_CLI_EXIT.ok);
        } catch (error) {
            const read = readError(error);
            fail(`${read.code}: ${read.hint}`, FLEET_SCHEDULE_CLI_EXIT.failed);
        }
    });

const updateScheduleCommand = new Command('update')
    .description(
        'Change a schedule: name, command, folder, when, or --on to move it to another computer',
    )
    .argument('<id>', 'The schedule id')
    .option('--on <computer>', 'Move it to this computer')
    .option('--name <name>', 'A new name')
    .option('--command <command>', 'A new command line')
    .option('--folder <dir>', 'A new folder ("~" for home)')
    .option('--every <interval>', 'Every N minutes (30m) or hourly (1h)')
    .option('--at <HH:MM>', 'Daily at this time')
    .option('--weekdays', 'With --at: Monday to Friday')
    .option('--days <days>', 'With --at: on these days')
    .option('--cron <expr>', 'A five-field cron expression')
    .option('--json', 'Print the schedule as JSON')
    .option('-y, --yes', 'Skip the confirmation (it is still printed)')
    .action(
        async (
            id: string,
            options: {
                on?: string;
                name?: string;
                command?: string;
                folder?: string;
                every?: string;
                at?: string;
                weekdays?: boolean;
                days?: string;
                cron?: string;
                json?: boolean;
                yes?: boolean;
            },
        ) => {
            const changesWhen = Boolean(options.every || options.at || options.cron);
            const built = changesWhen ? cadenceFromFlags(options) : { cadence: null, error: null };
            if (changesWhen && !built.cadence) fail(built.error ?? 'say when it runs');
            await requireAuth();
            const node = options.on ? await oneNode(options.on) : null;
            const http = getHttpClient();
            const body: Record<string, unknown> = {
                ...(options.name !== undefined ? { name: options.name } : {}),
                ...(node ? { nodeId: node.id } : {}),
                ...(options.command !== undefined ? { command: options.command } : {}),
                ...(options.folder !== undefined
                    ? { cwd: options.folder === '~' ? null : options.folder }
                    : {}),
                ...(built.cadence ? { cadence: built.cadence } : {}),
            };
            if (Object.keys(body).length === 0) fail('nothing to change');
            const updated = await withConfirmation(
                async (confirm) =>
                    (
                        await http.patch<FleetScheduleView>(
                            `/fleet/commands/${encodeURIComponent(id)}`,
                            { ...body, ...(confirm ? { confirm: true } : {}) },
                        )
                    ).data,
                options,
            );
            if (options.json) console.log(JSON.stringify(updated));
            else printSchedule(updated);
            process.exit(FLEET_SCHEDULE_CLI_EXIT.ok);
        },
    );

function controlCommand(name: 'run' | 'pause' | 'resume', description: string): Command {
    const path = name === 'run' ? 'run-now' : name;
    return new Command(name)
        .description(description)
        .argument('<id>', 'The schedule id')
        .option('--json', 'Print the answer as JSON')
        .option('-y, --yes', 'Run without a prompt (Run now only)')
        .action(async (id: string, options: { json?: boolean; yes?: boolean }) => {
            await requireAuth();
            if (name === 'run' && !options.yes) {
                if (!process.stdin.isTTY) fail('pass --yes to run without a prompt');
                if (
                    !(await askYes(
                        'Run it now on its computer? These are real machines, not a sandbox. [y/N] ',
                    ))
                ) {
                    fail('not run', FLEET_SCHEDULE_CLI_EXIT.failed);
                }
            }
            try {
                const { data } = await getHttpClient().post<unknown>(
                    `/schedules/${encodeURIComponent(fleetNodeScheduleRowId(id))}/${path}`,
                    name === 'run' ? { confirm: true } : {},
                );
                if (options.json) console.log(JSON.stringify(data));
                else
                    console.log(
                        name === 'run'
                            ? 'Running now. The next scheduled fire does not move.'
                            : name === 'pause'
                              ? 'Paused.'
                              : 'Resumed.',
                    );
                process.exit(FLEET_SCHEDULE_CLI_EXIT.ok);
            } catch (error) {
                const read = readError(error);
                fail(`${read.code}: ${read.hint}`, FLEET_SCHEDULE_CLI_EXIT.failed);
            }
        });
}

const runsScheduleCommand = new Command('runs')
    .description('The last runs of a schedule, newest first')
    .argument('<id>', 'The schedule id')
    .option('--json', 'Print one JSON object per run')
    .action(async (id: string, options: { json?: boolean }) => {
        await requireAuth();
        try {
            const http = getHttpClient();
            const { data: schedule } = await http.get<FleetScheduleView>(
                `/fleet/commands/${encodeURIComponent(id)}`,
            );
            const { data: runs } = await http.get<FleetCommandRunView[]>(
                `/fleet/commands/${encodeURIComponent(id)}/runs?limit=30`,
            );
            if (options.json) {
                for (const run of runs) console.log(JSON.stringify(run));
            } else {
                const computer = schedule.nodeName ?? 'its computer';
                for (const run of runs) {
                    const when = formatFleetScheduleInstant(
                        Date.parse(run.scheduledFor ?? run.startedAt),
                        schedule.nodeTimeZone,
                    );
                    const skip = describeFleetScheduleSkip(run.status, computer);
                    const outcome =
                        skip ??
                        (run.status === 'done'
                            ? `exit ${run.exitCode ?? 0}`
                            : `${run.status}${run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}`);
                    console.log(
                        `${when}${run.scheduledFor === null ? ' (run now)' : ''} · ${outcome}`,
                    );
                }
            }
            process.exit(FLEET_SCHEDULE_CLI_EXIT.ok);
        } catch (error) {
            const read = readError(error);
            fail(`${read.code}: ${read.hint}`, FLEET_SCHEDULE_CLI_EXIT.failed);
        }
    });

const deleteScheduleCommand = new Command('delete')
    .description('Delete a schedule (it stops on the computer; its runs stay readable for 30 days)')
    .argument('<id>', 'The schedule id')
    .option('--json', 'Print the deleted schedule as JSON')
    .option('-y, --yes', 'Skip the confirmation (it is still printed)')
    .action(async (id: string, options: { json?: boolean; yes?: boolean }) => {
        await requireAuth();
        const http = getHttpClient();
        const deleted = await withConfirmation(
            async (confirm) =>
                (
                    await http.delete<FleetScheduleView>(
                        `/fleet/commands/${encodeURIComponent(id)}`,
                        { data: confirm ? { confirm: true } : {} },
                    )
                ).data,
            options,
        );
        if (options.json) console.log(JSON.stringify(deleted));
        else console.log(`Deleted ${deleted.name}.`);
        process.exit(FLEET_SCHEDULE_CLI_EXIT.ok);
    });

/** `ever-works fleet schedules …` (alias `fleet schedule`). */
export const schedulesCommand = new Command('schedules')
    .alias('schedule')
    .description("Schedules on computers: commands that run on a computer's own clock")
    .addCommand(createCommand)
    .addCommand(listSchedulesCommand)
    .addCommand(getScheduleCommand)
    .addCommand(updateScheduleCommand)
    .addCommand(controlCommand('run', 'Run a schedule now (the next fire does not move)'))
    .addCommand(controlCommand('pause', 'Pause a schedule (its cadence is kept)'))
    .addCommand(controlCommand('resume', 'Resume a paused schedule'))
    .addCommand(runsScheduleCommand)
    .addCommand(deleteScheduleCommand);
