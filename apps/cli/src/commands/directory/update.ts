import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';

export const updateCommand = new Command('update')
    .description('Update a directory and its GitHub repository')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🔄 Update Directory\n'));

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

            // Prompt for update parameters
            const answers = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'generation_method',
                    message: 'Generation method:',
                    choices: [
                        { name: 'Create/Update (incremental)', value: 'create-update' },
                        { name: 'Recreate (full rebuild)', value: 'recreate' },
                    ],
                    default: 'create-update',
                },
                {
                    type: 'confirm',
                    name: 'update_with_pull_request',
                    message: 'Update with pull request?',
                    default: true,
                },
            ]);

            // Show summary and confirm
            console.log(chalk.cyan('\n--- Update Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('Generation Method:'), chalk.white(answers.generation_method));
            console.log(
                chalk.gray('Use Pull Request:'),
                chalk.white(answers.update_with_pull_request ? 'Yes' : 'No'),
            );

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with update?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Update cancelled.'));
                return;
            }

            // Start update
            const spinner = ora('Starting update process...').start();

            try {
                const updateDto = {
                    generation_method: answers.generation_method,
                    update_with_pull_request: answers.update_with_pull_request,
                };

                const response = await apiService.updateDirectory(directory.id, updateDto);

                spinner.succeed('Update started successfully');

                console.log(chalk.green('\n✓ Update process started!'));
                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }
            } catch (error) {
                spinner.fail('Update failed');
                throw error;
            }
        } catch (error) {
            console.error(
                chalk.red('\n✗ Failed to start update:'),
                error.response?.data?.message || error.message,
            );

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 404) {
                console.log(
                    chalk.yellow('\n⚠ Directory not found. Please check the slug and try again.'),
                );
            }

            process.exit(1);
        }
    });
