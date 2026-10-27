import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import {
    isFleetSessionActionId,
    type FleetCheckoutChangesReply,
    type FleetOpenPullRequestResponse,
    type FleetSessionActionSendResponse,
    type FleetSessionActionsResponse,
} from '@ever-works/contracts';
import { requireAuth } from '../../auth';
import { getHttpClient } from '../../../services/http-client';
import { SESSION_CLI_EXIT } from './attach.shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session git & actions (FL-06 P3, plan §9, CONTRACTS §11.3) —
 *
 *   ever-works fleet session actions <sessionId> [--json]
 *   ever-works fleet session action <sessionId> <actionId> [--prompt-file <path>] [--json]
 *   ever-works fleet checkout changes <checkoutId> [--json]
 *   ever-works fleet checkout pull-request <checkoutId> --title <t> [--body <b>] [--draft] [--json]
 *
 * The same routes, shapes and refusals as the app and the Agent tools. Exit
 * codes: 0 done, 1 refused or failed, 2 usage.
 */

function refused(error: unknown, json: boolean): never {
    const body = (error as { response?: { data?: { error?: { code?: string; hint?: string } } } })
        .response?.data;
    const envelope = body?.error ?? {
        code: 'internal',
        hint: error instanceof Error ? error.message : 'error',
    };
    if (json) process.stdout.write(`${JSON.stringify({ error: envelope }, null, 2)}\n`);
    else
        console.error(
            chalk.red(`Refused: ${envelope.code ?? 'internal'} — ${envelope.hint ?? ''}`),
        );
    process.exit(SESSION_CLI_EXIT.refused);
}

function usage(message: string): never {
    console.error(chalk.red(`Error: ${message}`));
    process.exit(SESSION_CLI_EXIT.usage);
}

export const actionsListCommand = new Command('actions')
    .description(
        'List the actions a session offers (commit, push, pull request, review, …) and why the others are hidden',
    )
    .argument('<id>', 'The session id')
    .option('--json', 'Print JSON')
    .action(async (id: string, options: { json?: boolean }) => {
        if (!UUID.test(id)) usage('<id> must be a session id (a UUID)');
        await requireAuth();
        try {
            const data = (
                await getHttpClient().get<FleetSessionActionsResponse>(
                    `/fleet/sessions/${id}/actions`,
                )
            ).data;
            if (options.json) {
                process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
                process.exit(SESSION_CLI_EXIT.ok);
            }
            if (data.disabled)
                console.log(chalk.yellow(`${data.disabled.code}: ${data.disabled.hint}`));
            for (const action of data.actions) {
                const label = action.update
                    ? `${action.id} (update #${action.update.number})`
                    : action.id;
                console.log(
                    action.available
                        ? `  ${chalk.green('●')} ${label}`
                        : `  ${chalk.gray('○')} ${chalk.gray(`${label} — ${action.reason}`)}`,
                );
            }
            process.exit(SESSION_CLI_EXIT.ok);
        } catch (error) {
            refused(error, options.json === true);
        }
    });

export const actionSendCommand = new Command('action')
    .description(
        'Type one of a session’s actions into it (its template, or the prompt in --prompt-file)',
    )
    .argument('<id>', 'The session id')
    .argument(
        '<actionId>',
        'commit | commitPush | pullRequest | review | fixComments | resolveConflicts | recap',
    )
    .option('--prompt-file <path>', 'Send this text instead of the action’s template')
    .option('--json', 'Print JSON ({ ledgerId, delivery })')
    .action(
        async (id: string, actionId: string, options: { promptFile?: string; json?: boolean }) => {
            if (!UUID.test(id)) usage('<id> must be a session id (a UUID)');
            if (!isFleetSessionActionId(actionId)) usage('<actionId> is one of the seven actions');
            await requireAuth();
            try {
                let prompt: string;
                if (options.promptFile) {
                    try {
                        prompt = readFileSync(options.promptFile, 'utf8');
                    } catch {
                        usage(`cannot read ${options.promptFile}`);
                    }
                } else {
                    const listing = (
                        await getHttpClient().get<FleetSessionActionsResponse>(
                            `/fleet/sessions/${id}/actions`,
                        )
                    ).data;
                    prompt = listing.templates[actionId].text;
                }
                const data = (
                    await getHttpClient().post<FleetSessionActionSendResponse>(
                        `/fleet/sessions/${id}/actions`,
                        {
                            actionId,
                            prompt,
                        },
                    )
                ).data;
                if (options.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
                else if (data.delivery === 'delivered')
                    console.log(chalk.green(`✓ ${actionId} sent`));
                else
                    console.log(
                        chalk.yellow(
                            `${actionId}: not delivered — send it again (ledger ${data.ledgerId})`,
                        ),
                    );
                process.exit(
                    data.delivery === 'undelivered'
                        ? SESSION_CLI_EXIT.refused
                        : SESSION_CLI_EXIT.ok,
                );
            } catch (error) {
                refused(error, options.json === true);
            }
        },
    );

export const checkoutChangesCommand = new Command('changes')
    .description('Show a checkout’s uncommitted diff, read on its computer (capped at 1 MiB)')
    .argument('<id>', 'The checkout id')
    .option('--json', 'Print JSON')
    .action(async (id: string, options: { json?: boolean }) => {
        if (!UUID.test(id)) usage('<id> must be a checkout id (a UUID)');
        await requireAuth();
        try {
            const data = (
                await getHttpClient().get<FleetCheckoutChangesReply>(
                    `/fleet/checkouts/${id}/changes`,
                )
            ).data;
            if (options.json) {
                process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
                process.exit(SESSION_CLI_EXIT.ok);
            }
            if (data.files.length === 0) console.log(chalk.green('Nothing uncommitted.'));
            for (const file of data.files) {
                const counts = file.binary ? 'binary' : `+${file.added ?? 0} −${file.removed ?? 0}`;
                console.log(`${chalk.white(file.path)}  ${chalk.gray(file.status)}  ${counts}`);
                if (file.patch) process.stdout.write(`${file.patch}\n`);
            }
            if (data.omittedFiles > 0 || data.omittedBytes > 0) {
                console.log(
                    chalk.yellow(
                        `${data.omittedFiles} file(s) omitted (${data.omittedBytes} bytes)`,
                    ),
                );
            }
            process.exit(SESSION_CLI_EXIT.ok);
        } catch (error) {
            refused(error, options.json === true);
        }
    });

export const checkoutPullRequestCommand = new Command('pull-request')
    .description(
        'Open the pull request of a checkout’s pushed branch through the GitHub App, or update the open one',
    )
    .argument('<id>', 'The checkout id')
    .requiredOption('--title <title>', 'At most 70 characters')
    .option('--body <body>', 'What changed and why')
    .option('--draft', 'Open it as a draft')
    .option('--json', 'Print JSON')
    .action(
        async (
            id: string,
            options: { title: string; body?: string; draft?: boolean; json?: boolean },
        ) => {
            if (!UUID.test(id)) usage('<id> must be a checkout id (a UUID)');
            await requireAuth();
            try {
                const data = (
                    await getHttpClient().post<FleetOpenPullRequestResponse>(
                        `/fleet/checkouts/${id}/pull-request`,
                        {
                            title: options.title,
                            ...(options.body ? { body: options.body } : {}),
                            ...(options.draft ? { draft: true } : {}),
                        },
                    )
                ).data;
                if (options.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
                else
                    console.log(
                        chalk.green(
                            `✓ ${data.updated ? 'updated' : 'opened'} #${data.number} ${data.url}`,
                        ),
                    );
                process.exit(SESSION_CLI_EXIT.ok);
            } catch (error) {
                refused(error, options.json === true);
            }
        },
    );
