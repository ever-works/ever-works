import { Command } from 'commander';
import chalk from 'chalk';
import type { FleetSessionAnswerResponse, FleetSessionView } from '@ever-works/contracts';
import { requireAuth } from '../../auth';
import { getHttpClient } from '../../../services/http-client';
import { SESSION_CLI_EXIT } from './attach.shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ever-works fleet session answer <id> [option] [--text "…"] [--key <key>] [--json]`
 * (FL-05 P2, plan §9) — answer what a session waits for: one of its options
 * (by id) or a free text. Without `--key` the session's CURRENT attention
 * key is read first, so an answer never lands on a prompt the person did not
 * see change. Exit `0`, `1` when the platform refused (already answered, the
 * computer away, the fleet stop), `2` on a usage error.
 */
export const answerCommand = new Command('answer')
    .description('Answer what a session is waiting for')
    .argument('<id>', 'The session id')
    .argument('[option]', 'The option id (see `fleet session question`)')
    .option('--text <text>', 'A free-text answer, for a question that takes one')
    .option('--key <key>', 'The attention key you saw (default: the current one)')
    .option('--json', 'Print JSON')
    .action(
        async (
            id: string,
            option: string | undefined,
            options: { text?: string; key?: string; json?: boolean },
        ) => {
            if (!UUID.test(id)) {
                console.error(chalk.red('Error: <id> must be a session id (a UUID)'));
                process.exit(SESSION_CLI_EXIT.usage);
            }
            if ((option === undefined) === (options.text === undefined)) {
                console.error(chalk.red('Error: give exactly one of an option or --text'));
                process.exit(SESSION_CLI_EXIT.usage);
            }
            await requireAuth();
            const http = getHttpClient();
            const refused = (error: unknown) => {
                const body = (error as { response?: { data?: { error?: { hint?: string } } } })
                    .response?.data;
                console.error(
                    chalk.red(
                        `Refused: ${body?.error?.hint ?? (error instanceof Error ? error.message : 'error')}`,
                    ),
                );
                process.exit(SESSION_CLI_EXIT.refused);
            };
            let key = options.key;
            if (!key) {
                try {
                    const view = (await http.get<FleetSessionView>(`/fleet/sessions/${id}`)).data;
                    key =
                        view.attention && view.attention.reason !== 'finished'
                            ? view.attention.key
                            : undefined;
                } catch (error) {
                    refused(error);
                }
                if (!key) {
                    console.error(chalk.red('Refused: nothing is waiting in this session'));
                    process.exit(SESSION_CLI_EXIT.refused);
                }
            }
            let result: FleetSessionAnswerResponse;
            try {
                result = (
                    await http.post<FleetSessionAnswerResponse>(`/fleet/sessions/${id}/answer`, {
                        key,
                        ...(option !== undefined ? { optionId: option } : { text: options.text }),
                        source: 'cli',
                    })
                ).data;
            } catch (error) {
                refused(error);
                return;
            }
            if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            else console.log(chalk.green('Answered.'));
            process.exit(SESSION_CLI_EXIT.ok);
        },
    );
