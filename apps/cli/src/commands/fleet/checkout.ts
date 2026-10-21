import { Command } from 'commander';
import chalk from 'chalk';
import type {
    FleetCheckoutCreateRequest,
    FleetCheckoutListResponse,
    FleetCheckoutView,
} from '@ever-works/contracts';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';

/**
 * Checkouts on computers (FL-14 P2, CONTRACTS §11.3) — `ever-works fleet
 * checkouts list|get|create|sync|archive|delete [--json]` (singular alias
 * `fleet checkout`). The same routes, shapes and refusals as the app and the
 * Agent tools: a confirmation class is satisfied with `--confirm` or
 * `--confirm-name <folder>` (CONTRACTS §2.2); without it the command prints
 * what to confirm and exits 1.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */

const UUID = /^[0-9a-f-]{36}$/i;

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

function emit(json: boolean, value: unknown, human: () => void): void {
    if (json) {
        console.log(JSON.stringify(value, null, 2));
        return;
    }
    human();
}

function fail(json: boolean, error: unknown): never {
    const typed = readError(error);
    if (json) console.log(JSON.stringify({ error: typed }, null, 2));
    else {
        console.error(chalk.red(`✗ ${typed.code}: ${typed.hint}`));
        if (typed.code === 'confirmation_required' && typed.details) {
            const summary = typeof typed.details.summary === 'string' ? typed.details.summary : null;
            if (summary) console.error(chalk.yellow(summary));
            console.error(
                chalk.gray(
                    typed.details.class === 'confirm-destructive'
                        ? `Repeat with --confirm-name ${String(typed.details.name ?? '<folder>')}`
                        : 'Repeat with --confirm',
                ),
            );
        }
    }
    process.exit(1);
}

function line(checkout: FleetCheckoutView): string {
    const git = checkout.gitLine;
    const changes = git
        ? git.uncommitted > 0
            ? chalk.yellow(`● ${git.uncommitted} uncommitted`)
            : chalk.green('✓ clean')
        : chalk.gray('—');
    const ahead = git?.ahead ? ` ↑${git.ahead}` : '';
    const behind = git?.behind ? ` ↓${git.behind}` : '';
    return `${chalk.white(checkout.path)}  ${chalk.cyan(checkout.branch ?? '(detached)')}  ${changes}${ahead}${behind}  ${chalk.gray(
        `[${checkout.state}] ${checkout.repository ?? 'no repository'} · ${checkout.id}`,
    )}`;
}

const list = new Command('list')
    .description('List checkouts on your computers (one computer with --node)')
    .option('--node <id>', 'Only this computer')
    .option('--state <state>', 'creating | ready | missing | archived (the bin)')
    .option('--json', 'Machine-readable output')
    .action(async (options: { node?: string; state?: string; json?: boolean }) => {
        if (options.node && !UUID.test(options.node)) usage('--node must be a computer id');
        await requireAuth();
        try {
            const params = new URLSearchParams();
            if (options.node) params.set('nodeId', options.node);
            if (options.state) params.set('state', options.state);
            const query = params.toString();
            const response = await getHttpClient().get<FleetCheckoutListResponse>(
                `/fleet/checkouts${query ? `?${query}` : ''}`,
            );
            emit(options.json === true, response.data, () => {
                if (response.data.data.length === 0) console.log(chalk.yellow('No checkouts.'));
                for (const checkout of response.data.data) console.log(line(checkout));
                if (response.data.meta.bin > 0) console.log(chalk.gray(`Bin: ${response.data.meta.bin}`));
            });
        } catch (error) {
            fail(options.json === true, error);
        }
    });

const get = new Command('get')
    .description('Show one checkout')
    .argument('<id>', 'Checkout id')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, options: { json?: boolean }) => {
        if (!UUID.test(id)) usage('<id> must be a checkout id');
        await requireAuth();
        try {
            const response = await getHttpClient().get<FleetCheckoutView>(`/fleet/checkouts/${id}`);
            emit(options.json === true, response.data, () => console.log(line(response.data)));
        } catch (error) {
            fail(options.json === true, error);
        }
    });

const create = new Command('create')
    .description('Create a checkout: a fresh clone (--repo) or a worktree of a checkout (--worktree-of)')
    .requiredOption('--node <id>', 'The computer')
    .option('--repo <url>', 'Repository URL to clone (no credential in it)')
    .option('--worktree-of <checkoutId>', 'A checkout on the same computer to branch off')
    .option('--branch <name>', 'Branch name (proposed and made unique when absent)')
    .option('--base <ref>', 'What a new branch starts from')
    .option('--json', 'Machine-readable output')
    .action(
        async (options: {
            node: string;
            repo?: string;
            worktreeOf?: string;
            branch?: string;
            base?: string;
            json?: boolean;
        }) => {
            if (!UUID.test(options.node)) usage('--node must be a computer id');
            if (!options.repo === !options.worktreeOf) usage('give exactly one of --repo or --worktree-of');
            await requireAuth();
            const body: FleetCheckoutCreateRequest = {
                nodeId: options.node,
                source: options.worktreeOf
                    ? { kind: 'worktree', parentCheckoutId: options.worktreeOf }
                    : { kind: 'clone', repoUrl: options.repo ?? '' },
            };
            if (options.branch) body.branch = options.branch;
            if (options.base) body.baseRef = options.base;
            try {
                const response = await getHttpClient().post(`/fleet/checkouts`, body);
                emit(options.json === true, response.data, () =>
                    console.log(chalk.green(`✓ creating ${response.data.checkout.path}`)),
                );
            } catch (error) {
                fail(options.json === true, error);
            }
        },
    );

const sync = new Command('sync')
    .description('Fetch, pull (fast-forward only) or push a checkout')
    .argument('<id>', 'Checkout id')
    .argument('<op>', 'fetch | pull | push')
    .option('--confirm', 'Confirm a pull or push')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, op: string, options: { confirm?: boolean; json?: boolean }) => {
        if (!UUID.test(id)) usage('<id> must be a checkout id');
        if (!['fetch', 'pull', 'push'].includes(op)) usage('<op> must be fetch, pull or push');
        await requireAuth();
        try {
            const response = await getHttpClient().post(`/fleet/checkouts/${id}/sync`, {
                op,
                ...(options.confirm ? { confirm: true } : {}),
            });
            emit(options.json === true, response.data, () =>
                console.log(
                    response.data.operationId
                        ? chalk.cyan(`… ${op} running (operation ${response.data.operationId})`)
                        : chalk.green(`✓ ${op} done`),
                ),
            );
        } catch (error) {
            fail(options.json === true, error);
        }
    });

const archive = new Command('archive')
    .description('Move a checkout to the bin (the folder is not touched)')
    .argument('<id>', 'Checkout id')
    .option('--confirm', 'Confirm')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, options: { confirm?: boolean; json?: boolean }) => {
        if (!UUID.test(id)) usage('<id> must be a checkout id');
        await requireAuth();
        try {
            const response = await getHttpClient().post(`/fleet/checkouts/${id}/archive`, {
                confirm: options.confirm === true,
            });
            emit(options.json === true, response.data, () => console.log(chalk.green('✓ in the bin')));
        } catch (error) {
            fail(options.json === true, error);
        }
    });

const remove = new Command('delete')
    .description('Delete a checkout Ever Works created, or forget one found on the computer (--forget)')
    .argument('<id>', 'Checkout id')
    .option('--forget', 'Remove the row only; the folder is not touched')
    .option('--confirm', 'Confirm (nothing would be lost)')
    .option('--confirm-name <folder>', 'Confirm a delete that would lose work: the checkout folder name')
    .option('--json', 'Machine-readable output')
    .action(
        async (
            id: string,
            options: { forget?: boolean; confirm?: boolean; confirmName?: string; json?: boolean },
        ) => {
            if (!UUID.test(id)) usage('<id> must be a checkout id');
            await requireAuth();
            try {
                const response = await getHttpClient().delete(`/fleet/checkouts/${id}`, {
                    data: {
                        ...(options.forget ? { mode: 'forget' } : {}),
                        ...(options.confirm ? { confirm: true } : {}),
                        ...(options.confirmName ? { confirmName: options.confirmName } : {}),
                    },
                });
                emit(options.json === true, response.data, () =>
                    console.log(chalk.green(options.forget ? '✓ forgotten' : '✓ deleted (the bin shows it)')),
                );
            } catch (error) {
                fail(options.json === true, error);
            }
        },
    );

export const checkoutsCommand = new Command('checkouts')
    .alias('checkout')
    .description('Checkouts (git clones and worktrees) on your computers')
    .addCommand(list)
    .addCommand(get)
    .addCommand(create)
    .addCommand(sync)
    .addCommand(archive)
    .addCommand(remove);
