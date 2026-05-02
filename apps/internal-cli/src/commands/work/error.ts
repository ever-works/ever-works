import { COMMAND } from '../../config';
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
    console.error(chalk.red(`\n✗ ${messageHeader}:`), String(message));

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
            console.log(
                chalk.yellow('\n⚠ Work not found. Please check your input and try again.'),
            );
        } else {
            console.log(
                chalk.yellow('\n⚠ Resource not found. Please check your input and try again.'),
            );
        }
    }
}
