import chalk from 'chalk';

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
