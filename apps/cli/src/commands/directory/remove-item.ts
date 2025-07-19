import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { DirectoryPromptService } from './directory-prompt.service';

export const removeItemCommand = new Command('remove-item')
    .description('Remove an item from a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🗑️  Remove Item\n'));

            // Ensure user is authenticated
            await requireAuth();

            const httpClient = getHttpClient();
            const directoryPrompt = new DirectoryPromptService();

            // Select directory
            const selection = await directoryPrompt.promptDirectorySelection();
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

            // Collect item information
            const answers = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'source_url',
                    message: 'Item URL to remove:',
                    validate: (input) => {
                        try {
                            new URL(input);
                            return true;
                        } catch {
                            return 'Please enter a valid URL';
                        }
                    }
                },
                {
                    type: 'input',
                    name: 'reason',
                    message: 'Reason for removal (optional):'
                }
            ]);

            // Show summary and confirm
            console.log(chalk.cyan('\n--- Item Removal Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('URL to remove:'), chalk.white(answers.source_url));
            if (answers.reason) console.log(chalk.gray('Reason:'), chalk.white(answers.reason));

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: chalk.red('Are you sure you want to remove this item?'),
                    default: false
                }
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Item removal cancelled.'));
                return;
            }

            // Remove item
            const spinner = ora('Removing item...').start();

            try {
                const removeDto = {
                    source_url: answers.source_url,
                    reason: answers.reason || undefined
                };

                const response = await httpClient.post(`/remove-item/${directory.slug}`, removeDto);
                
                spinner.succeed('Item removed successfully');

                console.log(chalk.green('\n✓ Item removed successfully!'));
                console.log(chalk.gray('Status:'), chalk.white(response.data.status));
                console.log(chalk.gray('Message:'), chalk.white(response.data.message));

            } catch (error) {
                spinner.fail('Item removal failed');
                throw error;
            }

        } catch (error) {
            console.error(chalk.red('\n✗ Failed to remove item:'), error.response?.data?.message || error.message);

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 404) {
                console.log(chalk.yellow('\n⚠ Directory or item not found. Please check the details and try again.'));
            }

            process.exit(1);
        }
    });
