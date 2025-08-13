import chalk from 'chalk';

export function handleCliError(error: any) {
    const data = error.response?.data;
    const status = error.response?.status;
    const message = data?.error_details || data?.message || error.message;

    console.error(chalk.red('\n✗ An error occurred:'), message);

    if (status === 401) {
        console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
        console.log(chalk.gray('Run: ever-works auth login'));
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
