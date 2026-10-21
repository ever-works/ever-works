import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'readline';
import {
    fleetCommandCliExitCode,
    type FleetCommandConfirmationDetails,
    type FleetCommandRunRequest,
    type FleetCommandView,
} from '@ever-works/contracts';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import {
    describeRunEnd,
    describeSummary,
    newRunPrintState,
    resolveNodeTokens,
    takeNewLines,
    type FleetNodeRef,
    type RunPrintState,
} from './command-output';

/**
 * Commands on computers (FL-12, spec FR-19, FR-21, S6) —
 * `ever-works fleet commands run --on <a,b> [--timeout <s>] [--cwd <dir>] [--json] [--yes] -- <cmd>`.
 *
 * Runs one command on the named computers through `POST /api/fleet/commands`
 * — the same route, the same confirmation (the platform's 409
 * `confirmation_required` summary is printed; `--yes`, or answering "y",
 * repeats the call with `confirm: true`) and the same refusals as the hub.
 * Output streams as `build-01 ▸ <line>` (read once a second while anything
 * runs), then one end line per computer and the summary. `--json` prints one
 * object per computer (`FleetCommandRunView`, the web's shape) when all ended.
 *
 * Exit codes: `0` every computer succeeded · `1` any failed or was refused ·
 * `2` usage error · `124` any timed out.
 */

const POLL_MS = 1_000;

/** Exit codes (spec FR-19). */
export const FLEET_CLI_EXIT = { ok: 0, failed: 1, usage: 2, timeout: 124 } as const;

interface ErrorBody {
    error?: { code?: string; hint?: string; details?: Record<string, unknown> };
}

function readError(error: unknown): { status: number; code: string; hint: string; details: Record<string, unknown> } {
    const response = (error as { response?: { status?: number; data?: ErrorBody } })?.response;
    const body = response?.data?.error;
    return {
        status: response?.status ?? 0,
        code: typeof body?.code === 'string' ? body.code : 'internal',
        hint:
            typeof body?.hint === 'string'
                ? body.hint
                : error instanceof Error
                  ? error.message
                  : 'the request failed',
        details: body?.details && typeof body.details === 'object' ? body.details : {},
    };
}

function fail(message: string, code: number = FLEET_CLI_EXIT.usage): never {
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

function printConfirmation(details: FleetCommandConfirmationDetails): void {
    console.log(chalk.bold(`$ ${details.command}`));
    for (const line of details.summary) {
        if (line.runnable) {
            console.log(
                `  ${line.nodeName}${line.os ? ` · ${line.os}` : ''} · ${line.shell} as the machine owner, from ${line.folder}`,
            );
        } else {
            console.log(chalk.gray(`  ${line.nodeName} — ${line.error?.hint ?? 'cannot run it'}`));
        }
    }
    console.log(chalk.gray(`  Timeout ${Math.max(1, Math.round(details.timeoutSec / 60))} min · no input is possible`));
    console.log(chalk.yellow(`  ⚠ ${details.sentence}`));
}

export const runCommand = new Command('run')
    .description('Run one command on one or more computers and stream what each one prints')
    .requiredOption('--on <computers>', 'Comma-separated computer names or ids')
    .option('--timeout <seconds>', 'Seconds before the command is ended (default 600, at most 3600)')
    .option('--cwd <dir>', "Folder to run it in (default the machine owner's home)")
    .option('--json', 'Print one JSON object per computer when every run ended')
    .option('-y, --yes', 'Skip the confirmation (it is still printed)')
    .argument('<command...>', 'The command, after --')
    .action(async (words: string[], options: { on: string; timeout?: string; cwd?: string; json?: boolean; yes?: boolean }) => {
        const commandLine = words.join(' ').trim();
        if (!commandLine) fail('give the command after --');
        let timeoutSec: number | undefined;
        if (options.timeout !== undefined) {
            const parsed = Number(options.timeout);
            if (!Number.isInteger(parsed) || parsed < 1) fail('--timeout must be a whole number of seconds');
            timeoutSec = parsed;
        }
        await requireAuth();
        const http = getHttpClient();

        let nodes: FleetNodeRef[] = [];
        try {
            const { data } = await http.get<Array<{ id: string; name: string }>>('/fleet/nodes?scope=visible');
            nodes = (Array.isArray(data) ? data : []).map((node) => ({ id: node.id, name: node.name }));
        } catch (error) {
            const read = readError(error);
            fail(`could not list your computers: ${read.hint}`, FLEET_CLI_EXIT.failed);
        }
        const resolved = resolveNodeTokens(options.on, nodes);
        if (resolved.unknown.length > 0) fail(`no computer named ${resolved.unknown.join(', ')}`);
        if (resolved.ambiguous.length > 0) {
            fail(`more than one computer is named ${resolved.ambiguous.join(', ')}; use its id`);
        }
        if (resolved.ids.length === 0) fail('--on names no computer');

        const request: FleetCommandRunRequest = {
            command: commandLine,
            nodeIds: resolved.ids,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        };

        // 1. The platform's confirmation (CONTRACTS §2.2): print it, then confirm.
        let view: FleetCommandView | null = null;
        try {
            const { data } = await http.post<FleetCommandView>('/fleet/commands', request);
            view = data;
        } catch (error) {
            const read = readError(error);
            if (read.code !== 'confirmation_required') {
                fail(`${read.code}: ${read.hint}`, read.status === 400 ? FLEET_CLI_EXIT.usage : FLEET_CLI_EXIT.failed);
            }
            const details = read.details as unknown as FleetCommandConfirmationDetails;
            if (!options.json) printConfirmation(details);
            if (!options.yes) {
                if (!process.stdin.isTTY) fail('pass --yes to run without a prompt');
                const runnable = typeof details.runnable === 'number' ? details.runnable : resolved.ids.length;
                if (!(await askYes(`Run on ${runnable}? [y/N] `))) fail('not run', FLEET_CLI_EXIT.failed);
            }
            try {
                const { data } = await http.post<FleetCommandView>('/fleet/commands', { ...request, confirm: true });
                view = data;
            } catch (again) {
                const second = readError(again);
                fail(`${second.code}: ${second.hint}`, FLEET_CLI_EXIT.failed);
            }
        }
        if (!view) fail('the command was not accepted', FLEET_CLI_EXIT.failed);

        // 2. Stream until every run ended.
        const states = new Map<string, RunPrintState>();
        const print = (current: FleetCommandView) => {
            if (options.json) return;
            for (const run of current.runs) {
                const state = states.get(run.id) ?? newRunPrintState();
                states.set(run.id, state);
                const name = run.nodeName ?? run.nodeId;
                for (const line of takeNewLines(run, state)) console.log(`${chalk.cyan(name)} ▸ ${line}`);
            }
        };
        let current: FleetCommandView = view;
        print(current);
        while (current.runs.some((run) => run.status === 'running')) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            try {
                const { data } = await http.get<FleetCommandView>(`/fleet/commands/${encodeURIComponent(current.id)}`);
                current = data;
            } catch (error) {
                const read = readError(error);
                if (read.status === 404) fail(`${read.code}: ${read.hint}`, FLEET_CLI_EXIT.failed);
                continue;
            }
            print(current);
        }

        // 3. The end.
        if (options.json) {
            for (const run of current.runs) console.log(JSON.stringify(run));
        } else {
            for (const run of current.runs) {
                const end = describeRunEnd(run);
                const name = run.nodeName ?? run.nodeId;
                console.log(run.status === 'done' ? chalk.green(`${name} ${end}`) : chalk.red(`${name} ${end}`));
            }
            console.log(describeSummary(current.summary));
        }
        process.exit(fleetCommandCliExitCode(current.runs));
    });

/** `ever-works fleet commands …` (alias `fleet command`). */
export const commandsCommand = new Command('commands')
    .alias('command')
    .description('Commands on computers: run one command on several computers')
    .addCommand(runCommand);
