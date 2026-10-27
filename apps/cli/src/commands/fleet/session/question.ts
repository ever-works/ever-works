import { Command } from 'commander';
import chalk from 'chalk';
import type { FleetSessionView } from '@ever-works/contracts';
import { requireAuth } from '../../auth';
import { getHttpClient } from '../../../services/http-client';
import { SESSION_CLI_EXIT } from './attach.shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ever-works fleet session question <id> [--json]` (FL-05 P2, plan §9) —
 * what a session waits for right now: the prompt, its numbered options, and
 * the attention key `fleet session answer` takes. `--json` prints
 * `{ state, attention }`. Exit `0`, `1` when the platform refused, `2` on a
 * usage error.
 */
export const questionCommand = new Command('question')
    .description('Show what a session is waiting for')
    .argument('<id>', 'The session id')
    .option('--json', 'Print JSON ({ state, attention })')
    .action(async (id: string, options: { json?: boolean }) => {
        if (!UUID.test(id)) {
            console.error(chalk.red('Error: <id> must be a session id (a UUID)'));
            process.exit(SESSION_CLI_EXIT.usage);
        }
        await requireAuth();
        let view: FleetSessionView;
        try {
            view = (await getHttpClient().get<FleetSessionView>(`/fleet/sessions/${id}`)).data;
        } catch (error) {
            const body = (error as { response?: { data?: { error?: { hint?: string } } } }).response
                ?.data;
            console.error(
                chalk.red(
                    `Refused: ${body?.error?.hint ?? (error instanceof Error ? error.message : 'error')}`,
                ),
            );
            process.exit(SESSION_CLI_EXIT.refused);
        }
        const attention =
            view.attention && view.attention.reason !== 'finished' ? view.attention : null;
        if (options.json) {
            process.stdout.write(`${JSON.stringify({ state: view.state, attention }, null, 2)}\n`);
            process.exit(SESSION_CLI_EXIT.ok);
        }
        if (!attention) {
            console.log(chalk.green(`Nothing is waiting (${view.state}).`));
            process.exit(SESSION_CLI_EXIT.ok);
        }
        console.log(chalk.yellow(`${attention.reason}: ${attention.prompt}`));
        for (const option of attention.options) {
            console.log(
                `  ${option.id}  ${option.label}${option.primary ? chalk.gray(' (first)') : ''}`,
            );
        }
        if (attention.allowsText) console.log(chalk.gray('  …or answer with --text "…"'));
        console.log(chalk.gray(`key: ${attention.key}`));
        process.exit(SESSION_CLI_EXIT.ok);
    });
