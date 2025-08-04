import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';

export const deleteCommand = new Command('delete')
    .description('Delete a directory')
    .action(async () => {
        try {
            console.log(chalk.red.bold('\n🗑️  Delete Directory\n'));

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

            // Show warning about what will be deleted
            console.log(chalk.red('\n⚠️  WARNING: This action cannot be undone!'));
            console.log(chalk.gray('This will delete:'));
            console.log(chalk.gray('  • The directory record from the database'));
            console.log(chalk.gray('  • Associated data and configurations'));
            console.log(chalk.gray('  • Note: GitHub repositories will NOT be deleted automatically'));

            // Collect deletion options
            const deleteOptions = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'delete_data_repository',
                    message: 'Delete data repository?',
                    default: true,
                },
                {
                    type: 'confirm',
                    name: 'delete_markdown_repository',
                    message: 'Delete markdown repository?',
                    default: true,
                },
                {
                    type: 'confirm',
                    name: 'delete_website_repository',
                    message: 'Delete website repository?',
                    default: true,
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
            console.log(chalk.red('\n--- Deletion Summary ---'));
            console.log(chalk.gray('Directory to delete:'), chalk.white(directory.slug));
            console.log(chalk.gray('Delete data repository:'), chalk.white(deleteOptions.delete_data_repository ? 'Yes' : 'No'));
            console.log(chalk.gray('Delete markdown repository:'), chalk.white(deleteOptions.delete_markdown_repository ? 'Yes' : 'No'));
            console.log(chalk.gray('Delete website repository:'), chalk.white(deleteOptions.delete_website_repository ? 'Yes' : 'No'));
            console.log(chalk.gray('Force delete:'), chalk.white(deleteOptions.force_delete ? 'Yes' : 'No'));
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
                    }
                }
            ]);

            const finalConfirmation = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: chalk.red('Are you absolutely sure you want to delete this directory?'),
                    default: false
                }
            ]);

            if (!finalConfirmation.proceed) {
                console.log(chalk.yellow('\n⚠ Directory deletion cancelled.'));
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

                const response = await apiService.deleteDirectory(directory.slug, deleteDto);

                spinner.succeed('Directory deleted successfully');

                console.log(chalk.green('\n✓ Directory deleted successfully!'));
                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }

                const anyRepoNotDeleted = !deleteOptions.delete_data_repository ||
                                         !deleteOptions.delete_markdown_repository ||
                                         !deleteOptions.delete_website_repository;

                if (anyRepoNotDeleted) {
                    console.log(chalk.yellow('\n⚠ Note: Some GitHub repositories were not deleted.'));
                    console.log(chalk.gray('You may want to manually delete them if no longer needed:'));
                    if (!deleteOptions.delete_data_repository) {
                        console.log(chalk.gray(`  • ${directory.getOwner()}/${directory.slug}-data`));
                    }
                    if (!deleteOptions.delete_website_repository) {
                        console.log(chalk.gray(`  • ${directory.getOwner()}/${directory.slug}-website`));
                    }
                }

            } catch (error) {
                spinner.fail('Directory deletion failed');
                throw error;
            }

        } catch (error) {
            console.error(chalk.red('\n✗ Failed to delete directory:'), error.response?.data?.message || error.message);

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 404) {
                console.log(chalk.yellow('\n⚠ Directory not found. It may have already been deleted.'));
            } else if (error.response?.status === 403) {
                console.log(chalk.yellow('\n⚠ Permission denied. You may not have permission to delete this directory.'));
            }

            process.exit(1);
        }
    });
