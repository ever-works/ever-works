import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import type {
    FleetCheckoutCreateResponse,
    FleetCheckoutView,
    FleetGitIdentity,
    FleetSessionView,
    FleetTaskHandoffOptions,
} from '@ever-works/contracts';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';

/**
 * Tasks on computers (FL-15 P3, CONTRACTS §11.3) — from the terminal:
 *
 *  - `ever-works fleet session start --task <taskId> --node <id> [--agent <id>]
 *    [--worktree | --clone | --checkout <id>] [--message-file <path>] [--json]`
 *    — hand a Task to an Agent session on a computer: the same options read
 *    and the same ONE start the app's dialog uses (`POST
 *    /api/fleet/nodes/:id/sessions` with `taskId`); a new worktree or a fresh
 *    clone is made first (FL-14) and waited on until it is ready;
 *  - `ever-works fleet nodes git-identity <nodeId> [--set [--confirm]] [--json]`
 *    — read a computer's global git identity, or **Use my Ever Works
 *    identity** (without `--confirm` it prints what would be set and exits 1).
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const CHECKOUT_WAIT_MS = 120_000;
const POLL_MS = 2_000;

interface CliError {
    code: string;
    hint: string;
    details?: Record<string, unknown>;
}

function readError(error: unknown): CliError {
    const response = (error as { response?: { data?: { error?: CliError; message?: string } } })?.response;
    const envelope = response?.data?.error;
    if (envelope && typeof envelope.code === 'string') return envelope;
    return {
        code: 'internal',
        hint: response?.data?.message ?? (error instanceof Error ? error.message : String(error)),
    };
}

function usage(message: string): never {
    console.error(chalk.red(message));
    process.exit(2);
}

function fail(json: boolean, error: unknown): never {
    const typed = readError(error);
    if (json) console.log(JSON.stringify({ error: typed }, null, 2));
    else {
        console.error(chalk.red(`✗ ${typed.code}: ${typed.hint}`));
        const summary = typeof typed.details?.summary === 'string' ? typed.details.summary : null;
        if (typed.code === 'confirmation_required' && summary) {
            console.error(chalk.yellow(summary));
            if (typeof typed.details?.name === 'string') console.error(`  Name:  ${typed.details.name}`);
            if (typeof typed.details?.email === 'string') console.error(`  Email: ${typed.details.email}`);
            console.error(chalk.gray('Repeat with --confirm to set it.'));
        }
    }
    process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const sessionStartCommand = new Command('start')
    .description('Hand a Task to an Agent session on one of your computers')
    .requiredOption('--task <taskId>', 'The Task')
    .requiredOption('--node <id>', 'The computer')
    .option('--agent <id>', 'The Agent (default: the first Run-with-agent candidate)')
    .option('--worktree', 'A new worktree of a checkout of the Task repository on the Task branch')
    .option('--clone', 'A fresh clone of the Task repository')
    .option('--checkout <id>', 'An existing ready checkout on the computer')
    .option('--message-file <path>', 'The first message (default: prefilled from the Task)')
    .option('--json', 'Print JSON (the FleetSessionView)')
    .action(
        async (options: {
            task: string;
            node: string;
            agent?: string;
            worktree?: boolean;
            clone?: boolean;
            checkout?: string;
            messageFile?: string;
            json?: boolean;
        }) => {
            const json = options.json === true;
            if (!UUID.test(options.task)) usage('Error: --task must be a Task id (a UUID)');
            if (!UUID.test(options.node)) usage('Error: --node must be a computer id (a UUID)');
            if (options.agent && !UUID.test(options.agent)) usage('Error: --agent must be an Agent id (a UUID)');
            if (options.checkout && !UUID.test(options.checkout)) usage('Error: --checkout must be a checkout id');
            if ([options.worktree, options.clone, options.checkout].filter(Boolean).length > 1) {
                usage('Error: choose one of --worktree, --clone, --checkout');
            }
            let firstMessage: string | null = null;
            if (options.messageFile) {
                try {
                    firstMessage = readFileSync(options.messageFile, 'utf8');
                } catch {
                    usage(`Error: cannot read ${options.messageFile}`);
                }
            }
            await requireAuth();
            const http = getHttpClient();

            let handoff: FleetTaskHandoffOptions;
            try {
                const query = options.agent ? `?agentId=${options.agent}` : '';
                handoff = (await http.get<FleetTaskHandoffOptions>(`/fleet/tasks/${options.task}/handoff-options${query}`))
                    .data;
            } catch (error) {
                fail(json, error);
            }
            const agent = handoff.agents.find((row) => row.id === (options.agent ?? handoff.agentId)) ?? null;
            if (!agent) fail(json, { response: { data: { error: { code: 'invalid', hint: 'no Agent can run this Task' } } } });
            const computer = handoff.computers.find((row) => row.nodeId === options.node);
            if (!computer) fail(json, { response: { data: { error: { code: 'not_found', hint: 'no such computer' } } } });
            if (!computer.selectable) {
                fail(json, {
                    response: {
                        data: { error: { code: 'invalid', hint: computer.hint ?? `${computer.name} cannot take this Task` } },
                    },
                });
            }
            const step = handoff.checkouts.find((row) => row.nodeId === options.node);
            const mode = options.checkout
                ? 'existing'
                : options.worktree
                  ? 'worktree'
                  : options.clone
                    ? 'clone'
                    : (step?.defaultMode ?? 'none');

            let checkout: { id: string; path: string } | null = null;
            if (mode === 'existing') {
                const id = options.checkout ?? step?.matching[0]?.checkoutId ?? step?.others[0]?.checkoutId;
                const ref = [...(step?.matching ?? []), ...(step?.others ?? [])].find((row) => row.checkoutId === id);
                if (!ref) fail(json, { response: { data: { error: { code: 'invalid', hint: 'that checkout is not ready on this computer' } } } });
                checkout = { id: ref.checkoutId, path: ref.path };
            } else if (mode === 'worktree' || mode === 'clone') {
                const parent = step?.matching[0];
                if (mode === 'worktree' && !parent) {
                    fail(json, { response: { data: { error: { code: 'invalid', hint: 'no checkout of the Task repository on this computer; use --clone' } } } });
                }
                if (mode === 'clone' && !handoff.task.repoUrl) {
                    fail(json, { response: { data: { error: { code: 'invalid', hint: 'the Task has no repository to clone' } } } });
                }
                let created: FleetCheckoutView;
                try {
                    created = (
                        await http.post<FleetCheckoutCreateResponse>('/fleet/checkouts', {
                            nodeId: options.node,
                            source:
                                mode === 'worktree'
                                    ? { kind: 'worktree', parentCheckoutId: parent!.checkoutId }
                                    : { kind: 'clone', repoUrl: handoff.task.repoUrl },
                            ...(handoff.task.branch ? { branch: handoff.task.branch } : {}),
                        })
                    ).data.checkout;
                } catch (error) {
                    fail(json, error);
                }
                const deadline = Date.now() + CHECKOUT_WAIT_MS;
                if (!json) console.log(chalk.gray(`Preparing ${created.path} on ${computer.name}…`));
                while (created.state === 'creating' && Date.now() < deadline) {
                    await sleep(POLL_MS);
                    try {
                        created = (await http.get<FleetCheckoutView>(`/fleet/checkouts/${created.id}`)).data;
                    } catch {
                        // keep waiting; the next read decides
                    }
                }
                if (created.state !== 'ready') {
                    fail(json, { response: { data: { error: { code: 'operation_failed', hint: `the checkout is ${created.state}` } } } });
                }
                checkout = { id: created.id, path: created.path };
            }

            try {
                const session = (
                    await http.post<FleetSessionView>(`/fleet/nodes/${options.node}/sessions`, {
                        kind: 'agent',
                        provider: agent.cli,
                        agentId: agent.id,
                        taskId: options.task,
                        firstMessage: firstMessage ?? handoff.firstMessage,
                        cwd: checkout?.path ?? '~',
                        ...(checkout ? { checkoutId: checkout.id } : {}),
                    })
                ).data;
                if (json) console.log(JSON.stringify(session, null, 2));
                else console.log(chalk.green(`✓ ${agent.name} is starting on ${computer.name} — session ${session.id}`));
                process.exit(0);
            } catch (error) {
                fail(json, error);
            }
        },
    );

export const gitIdentityCommand = new Command('git-identity')
    .description("Read a computer's global git identity, or set it to yours (--set)")
    .argument('<nodeId>', 'The computer')
    .option('--set', 'Use my Ever Works identity (name and email only)')
    .option('--confirm', 'Confirm the set')
    .option('--fresh', 'Read the computer again')
    .option('--json', 'Print JSON')
    .action(async (nodeId: string, options: { set?: boolean; confirm?: boolean; fresh?: boolean; json?: boolean }) => {
        const json = options.json === true;
        if (!UUID.test(nodeId)) usage('Error: <nodeId> must be a computer id (a UUID)');
        await requireAuth();
        const http = getHttpClient();
        try {
            const identity = options.set
                ? (
                      await http.post<FleetGitIdentity>(
                          `/fleet/nodes/${nodeId}/git/identity`,
                          options.confirm ? { confirm: true } : {},
                      )
                  ).data
                : (await http.get<FleetGitIdentity>(`/fleet/nodes/${nodeId}/git/identity${options.fresh ? '?fresh=1' : ''}`))
                      .data;
            if (json) {
                console.log(JSON.stringify(identity, null, 2));
            } else {
                const field = (value: { set: boolean; value?: string }) => value.value ?? (value.set ? 'set' : 'not set');
                console.log(`Name    ${field(identity.name)}`);
                console.log(`Email   ${field(identity.email)}`);
                console.log(`Helper  ${identity.helper.value ?? (identity.helper.present ? 'set' : 'none')}`);
                console.log(
                    `Ever Works can push for agents: ${
                        identity.canPushForAgents.ok
                            ? `yes — ${(identity.canPushForAgents.repositories ?? []).join(', ')}`
                            : `no — ${identity.canPushForAgents.reason ?? ''}`
                    }`,
                );
            }
            process.exit(0);
        } catch (error) {
            fail(json, error);
        }
    });

/**
 * FL-15 P3: kept for embedders that compose their own CLI; `ever-works fleet nodes git-identity` is
 * `gitIdentityCommand` added to FL-19's `fleet nodes` group (`./index.ts`).
 */
export const fleetNodesGitIdentityCommands: readonly Command[] = [gitIdentityCommand];

/** `ever-works fleet tasks handoff-options <taskId> [--agent <id>] [--json]` (the catalogue's CLI verb). */
export const handoffOptionsCommand = new Command('handoff-options')
    .description('Where a Task could be fixed: computers (and why not), checkouts, the first message')
    .argument('<taskId>', 'The Task')
    .option('--agent <id>', 'Judge the computers for this Agent')
    .option('--json', 'Print JSON (FleetTaskHandoffOptions)')
    .action(async (taskId: string, options: { agent?: string; json?: boolean }) => {
        const json = options.json === true;
        if (!UUID.test(taskId)) usage('Error: <taskId> must be a Task id (a UUID)');
        if (options.agent && !UUID.test(options.agent)) usage('Error: --agent must be an Agent id (a UUID)');
        await requireAuth();
        try {
            const query = options.agent ? `?agentId=${options.agent}` : '';
            const handoff = (
                await getHttpClient().get<FleetTaskHandoffOptions>(`/fleet/tasks/${taskId}/handoff-options${query}`)
            ).data;
            if (json) {
                console.log(JSON.stringify(handoff, null, 2));
                process.exit(0);
            }
            console.log(chalk.bold(`${handoff.task.slug} · ${handoff.task.title}`));
            if (handoff.task.branch) console.log(`Branch  ${handoff.task.branch}`);
            for (const computer of handoff.computers) {
                const mark = computer.selectable ? chalk.green('✓') : chalk.gray('·');
                console.log(
                    `${mark} ${computer.name.padEnd(20)} ${computer.online ? 'online ' : 'offline'} ${
                        computer.selectable ? '' : (computer.hint ?? computer.reason ?? '')
                    }`,
                );
            }
            process.exit(0);
        } catch (error) {
            fail(json, error);
        }
    });

/** `ever-works fleet tasks …` (FL-15 P3). */
export const fleetTasksCommand = new Command('tasks')
    .alias('task')
    .description('Tasks on your computers: handoff-options')
    .addCommand(handoffOptionsCommand);
