import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, GenerationMethod } from '../../services/api.service';
import type { UpdateItemsGeneratorDto } from '../../services/api.service';
import { DirectoryPromptService, canEdit } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

export const updateCommand = new Command('update')
    .description('Update a directory and its repository')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nUpdate Directory\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

            // Select directory
            const selection = await directoryPrompt.promptDirectorySelection();
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            const directory = selection.directory;
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected directory: ${directoryPrompt.formatSelectedDirectory(directory, role, isShared)}`,
                ),
            );

            if (!canEdit(role)) {
                console.log(chalk.yellow('\n⚠ You do not have permission to perform this action.'));
                console.log(chalk.gray(`  Your role: ${role}. Required: editor or higher.`));
                return;
            }

            // Prompt for update parameters
            const answers = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'generation_method',
                    message: 'Generation method:',
                    choices: [
                        {
                            name: 'Create/Update (incremental)',
                            value: GenerationMethod.CREATE_UPDATE,
                        },
                        { name: 'Recreate (full rebuild)', value: GenerationMethod.RECREATE },
                    ],
                    default: GenerationMethod.CREATE_UPDATE,
                },
                {
                    type: 'confirm',
                    name: 'update_with_pull_request',
                    message: 'Update with pull request?',
                    default: false,
                },
            ]);

            // Recreate confirmation
            if (answers.generation_method === GenerationMethod.RECREATE) {
                const { confirmRecreate } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'confirmRecreate',
                        message: chalk.yellow(
                            'Recreate will delete existing items and regenerate from scratch. This cannot be undone. Continue?',
                        ),
                        default: false,
                    },
                ]);
                if (!confirmRecreate) {
                    console.log(chalk.yellow('\nOperation cancelled.'));
                    return;
                }
            }

            // Show summary and confirm
            console.log('');
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
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            // Start update
            const spinner = ora('Starting update process...').start();

            try {
                const updateDto: UpdateItemsGeneratorDto = {
                    generation_method: answers.generation_method,
                    update_with_pull_request: answers.update_with_pull_request,
                };

                const response = await apiService.updateDirectory(directory.id, updateDto);

                if (response.status === 'error') {
                    spinner.fail('Update failed');
                } else {
                    spinner.succeed('Update process started!');
                }

                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }
            } catch (error) {
                spinner.fail('Update failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
