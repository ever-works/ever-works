import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

export const removeItemCommand = new Command('remove-item')
    .description('Remove an item from a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nRemove Item from Directory\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
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
                    name: 'item_slug',
                    message: 'Item slug to remove:',
                    validate: (input) => {
                        if (!input.trim()) return 'Item slug is required';
                        if (!/^[a-z0-9-]+$/.test(input)) {
                            return 'Item slug must contain only lowercase letters, numbers, and hyphens';
                        }
                        return true;
                    },
                },
                {
                    type: 'input',
                    name: 'reason',
                    message: 'Reason for removal (optional):',
                },
            ]);

            // Show summary and confirm
            console.log(chalk.cyan('\n--- Item Removal Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('Item slug to remove:'), chalk.white(answers.item_slug));
            if (answers.reason) {
                console.log(chalk.gray('Reason:'), chalk.white(answers.reason));
            }

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: chalk.red('Are you sure you want to remove this item?'),
                    default: false,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Item removal cancelled.'));
                return;
            }

            // Remove item
            const spinner = ora('Removing item...').start();

            try {
                const removeDto = {
                    item_slug: answers.item_slug,
                    reason: answers.reason || undefined,
                };

                const response = await apiService.removeItem(directory.id, removeDto);

                spinner.stop();

                if (response.status === 'error') {
                    console.log(chalk.red('\n✗ Item removal failed'));
                } else {
                    console.log(chalk.green('\n✓ Item removed successfully!'));
                }

                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }
            } catch (error) {
                spinner.fail('Item removal failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
