import chalk from 'chalk';
import { emitFleetError, readFleetCliError } from '../commands/fleet/fleet-output';

export function handleCliError(error: any) {
    if (!error) {
        console.error(chalk.red('\n✗ An error occurred:'));
        return;
    }

    if (typeof error === 'string') {
        console.error(chalk.red('\n✗ An error occurred:'), error);
        return;
    }

    const data = error.response?.data;
    const status = error.response?.status;
    const message = data?.message || error.message || error;

    console.error(chalk.red('\n✗ An error occurred:'), String(message));

    if (status === 401) {
        console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
        console.log(chalk.gray('Run: ever-works auth login'));
    } else if (status === 404) {
        if (message?.toLowerCase().includes('work')) {
            console.log(chalk.yellow('\n⚠ Work not found. Please check your input and try again.'));
        } else {
            console.log(
                chalk.yellow('\n⚠ Resource not found. Please check your input and try again.'),
            );
        }
    }
}

/**
 * FL-19 (plan §9.3) — the `ever-works fleet …` error path: maps an API refusal
 * to the `--json` envelope `{ ok: false, error: { code, hint, details } }` and
 * the contract's exit code (`2` for a missing confirmation or bad input, else
 * `1`), beside — never instead of — {@link handleCliError}.
 */
export function handleFleetCliError(error: unknown, options: { json: boolean }): never {
    return emitFleetError(options.json, readFleetCliError(error));
}
