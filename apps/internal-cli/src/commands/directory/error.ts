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

    console.log(error);
    console.error(chalk.red(`\n✗ ${messageHeader}:`), String(message));

    if (error.message?.includes('Owner is required')) {
        console.log(chalk.yellow('\n⚠ Make sure your GitHub configuration is set up correctly.'));
        console.log(
            chalk.gray('Run ') +
                chalk.cyan(`${COMMAND} config setup`) +
                chalk.gray(' to configure GitHub settings.'),
        );
    } else if (status === 404) {
        if (message?.toLowerCase().includes('directory')) {
            console.log(
                chalk.yellow('\n⚠ Directory not found. Please check your input and try again.'),
            );
        } else {
            console.log(
                chalk.yellow('\n⚠ Resource not found. Please check your input and try again.'),
            );
        }
    }
}
