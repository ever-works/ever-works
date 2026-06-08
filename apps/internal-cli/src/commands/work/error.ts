import { COMMAND } from '../../config';
import { redactSecrets } from '@ever-works/agent/utils';
import chalk from 'chalk';

export function handleCliError(error: any, messageHeader: string = 'An error occurred') {
    if (!error) {
        console.error(chalk.red(`\n✗ ${messageHeader}`));
        return;
    }

    if (typeof error === 'string') {
        console.error(chalk.red(`\n✗ ${messageHeader}:`), error);
        return;
    }

    const data = error.response?.data;
    const status = error.response?.status;
    const message = data?.message || error.message || error;

    if (process.env.DEBUG_CLI === 'true') {
        console.error(error);
    }
    // Security (EW-718): upstream API error messages can echo back secret-bearing
    // input (tokens, keys, Bearer headers). Redact before printing to the console.
    const safeMessage = redactSecrets(String(message)).cleaned;
    console.error(chalk.red(`\n✗ ${messageHeader}:`), safeMessage);

    if (error.message?.includes('Owner is required')) {
        console.log(
            chalk.yellow('\n⚠ Make sure your git provider configuration is set up correctly.'),
        );
        console.log(
            chalk.gray('Run ') +
                chalk.cyan(`${COMMAND} config setup`) +
                chalk.gray(' to configure git provider settings.'),
        );
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
