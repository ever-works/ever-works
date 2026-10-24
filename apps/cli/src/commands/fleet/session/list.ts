import { Command } from 'commander';
import chalk from 'chalk';
import type { FleetSessionListResponse } from '@ever-works/contracts';
import { requireAuth } from '../../auth';
import { getHttpClient } from '../../../services/http-client';
import { SESSION_CLI_EXIT } from './attach.shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ever-works fleet session list [--node <id>] [--state live|ended] [--json]`
 * (FL-04 P2, spec FR-53) — the sessions on the computers I may see, live
 * first. `--json` prints the platform's `FleetSessionView` objects verbatim.
 * Exit `0`, `1` when the platform refused, `2` on a usage error.
 */
export const listCommand = new Command('list')
    .description('List sessions on your computers')
    .option('--node <id>', 'Only this computer')
    .option('--state <state>', 'live or ended')
    .option('--limit <n>', 'Max sessions', '50')
    .option('--json', 'Print JSON (FleetSessionView[])')
    .action(async (options: { node?: string; state?: string; limit?: string; json?: boolean }) => {
        if (options.node && !UUID.test(options.node)) {
            console.error(chalk.red('Error: --node must be a computer id (a UUID)'));
            process.exit(SESSION_CLI_EXIT.usage);
        }
        if (options.state && options.state !== 'live' && options.state !== 'ended') {
            console.error(chalk.red('Error: --state is live or ended'));
            process.exit(SESSION_CLI_EXIT.usage);
        }
        const limit = Number(options.limit ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            console.error(chalk.red('Error: --limit is 1–200'));
            process.exit(SESSION_CLI_EXIT.usage);
        }
        await requireAuth();
        const query = new URLSearchParams({ limit: String(limit) });
        if (options.state) query.set('state', options.state);
        const path = options.node
            ? `/fleet/nodes/${options.node}/sessions?${query.toString()}`
            : `/fleet/sessions?${query.toString()}`;
        let page: FleetSessionListResponse;
        try {
            page = (await getHttpClient().get<FleetSessionListResponse>(path)).data;
        } catch (error) {
            const body = (error as { response?: { data?: { error?: { hint?: string } } } }).response?.data;
            console.error(chalk.red(`Refused: ${body?.error?.hint ?? (error instanceof Error ? error.message : 'error')}`));
            process.exit(SESSION_CLI_EXIT.refused);
        }
        if (options.json) {
            process.stdout.write(`${JSON.stringify(page.sessions, null, 2)}\n`);
            process.exit(SESSION_CLI_EXIT.ok);
        }
        if (page.sessions.length === 0) {
            console.log(chalk.yellow('No sessions.'));
            process.exit(SESSION_CLI_EXIT.ok);
        }
        for (const session of page.sessions) {
            const state = session.state === 'ended' ? chalk.gray(session.state.padEnd(9)) : chalk.green(session.state.padEnd(9));
            console.log(
                [session.id, state, session.kind.padEnd(5), session.provider.padEnd(11), session.title].join('  '),
            );
        }
        process.exit(SESSION_CLI_EXIT.ok);
    });
