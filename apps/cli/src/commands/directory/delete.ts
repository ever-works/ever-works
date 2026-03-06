import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService, canDelete } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

export const deleteCommand = new Command('delete')
    .description('Delete a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nDelete Directory\n'));

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

            if (!canDelete(role)) {
                console.log(chalk.yellow('\n⚠ Only the directory owner can delete a directory.'));
                console.log(chalk.gray(`  Your role: ${role}.`));
                return;
            }

            // Show warning about what will be deleted
            console.log(chalk.red('\n⚠️  WARNING: This action cannot be undone!'));
            console.log(chalk.gray('This will delete:'));
            console.log(chalk.gray('  • The directory record from the database'));
            console.log(chalk.gray('  • Associated data and configurations'));
            console.log(chalk.gray('  • Note: Git repositories will NOT be deleted automatically'));

            // Collect deletion options
            const deleteOptions = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'delete_data_repository',
                    message: 'Delete data repository?',
                    default: false,
                },
                {
                    type: 'confirm',
                    name: 'delete_markdown_repository',
                    message: 'Delete markdown repository?',
                    default: false,
                },
                {
                    type: 'confirm',
                    name: 'delete_website_repository',
                    message: 'Delete website repository?',
                    default: false,
                },
                {
                    type: 'confirm',
                    name: 'force_delete',
                    message: 'Force delete (skip safety checks)?',
                    default: false,
                },
                {
                    type: 'input',
                    name: 'reason',
                    message: 'Reason for deletion (optional):',
                },
            ]);

            // Double confirmation
            console.log('');
            console.log(chalk.gray('Directory to delete:'), chalk.white(directory.slug));
            console.log(
                chalk.gray('Delete data repository:'),
                chalk.white(deleteOptions.delete_data_repository ? 'Yes' : 'No'),
            );
            console.log(
                chalk.gray('Delete markdown repository:'),
                chalk.white(deleteOptions.delete_markdown_repository ? 'Yes' : 'No'),
            );
            console.log(
                chalk.gray('Delete website repository:'),
                chalk.white(deleteOptions.delete_website_repository ? 'Yes' : 'No'),
            );
            console.log(
                chalk.gray('Force delete:'),
                chalk.white(deleteOptions.force_delete ? 'Yes' : 'No'),
            );
            if (deleteOptions.reason) {
                console.log(chalk.gray('Reason:'), chalk.white(deleteOptions.reason));
            }

            await inquirer.prompt([
                {
                    type: 'input',
                    name: 'confirmation',
                    message: `Type "${directory.slug}" to confirm deletion:`,
                    validate: (input) => {
                        if (input !== directory.slug) {
                            return `You must type "${directory.slug}" exactly to confirm`;
                        }
                        return true;
                    },
                },
            ]);

            const finalConfirmation = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: chalk.red(
                        'Are you absolutely sure you want to delete this directory?',
                    ),
                    default: false,
                },
            ]);

            if (!finalConfirmation.proceed) {
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            // Delete directory
            const spinner = ora('Deleting directory...').start();

            try {
                const deleteDto = {
                    reason: deleteOptions.reason || undefined,
                    force_delete: deleteOptions.force_delete,
                    delete_data_repository: deleteOptions.delete_data_repository,
                    delete_markdown_repository: deleteOptions.delete_markdown_repository,
                    delete_website_repository: deleteOptions.delete_website_repository,
                };

                const response = await apiService.deleteDirectory(directory.id, deleteDto);

                if (response.status === 'error') {
                    spinner.fail('Directory deletion failed');
                } else {
                    spinner.succeed('Directory deleted successfully!');
                }

                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }

                const anyRepoNotDeleted =
                    !deleteOptions.delete_data_repository ||
                    !deleteOptions.delete_markdown_repository ||
                    !deleteOptions.delete_website_repository;

                if (anyRepoNotDeleted) {
                    console.log(chalk.yellow('\n⚠ Note: Some repositories were not deleted.'));
                    console.log(
                        chalk.gray('You may want to manually delete them if no longer needed:'),
                    );
                    if (!deleteOptions.delete_data_repository) {
                        console.log(chalk.gray(`  • ${directory.owner}/${directory.slug}-data`));
                    }
                    if (!deleteOptions.delete_website_repository) {
                        console.log(chalk.gray(`  • ${directory.owner}/${directory.slug}-website`));
                    }
                }
            } catch (error) {
                spinner.fail('Directory deletion failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
