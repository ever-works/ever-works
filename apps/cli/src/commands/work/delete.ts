import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { WorkPromptService, canDelete } from './work-prompt.service';
import { handleCliError } from '../../utils/error';

export const deleteCommand = new Command('delete').description('Delete a work').action(async () => {
    try {
        console.log(chalk.cyan.bold('\nDelete Work\n'));

        // Ensure user is authenticated
        await requireAuth();

        const apiService = getApiService();
        const workPrompt = new WorkPromptService();

        // Select work
        const selection = await workPrompt.promptWorkSelection();
        if (selection.cancelled || !selection.work) {
            console.log(chalk.yellow('\nOperation cancelled.'));
            return;
        }

        const work = selection.work;
        const role = selection.role!;
        const isShared = selection.isShared!;

        console.log(
            chalk.green(
                `\n✓ Selected work: ${workPrompt.formatSelectedWork(work, role, isShared)}`,
            ),
        );

        if (!canDelete(role)) {
            console.log(chalk.yellow('\n⚠ Only the work owner can delete a work.'));
            console.log(chalk.gray(`  Your role: ${role}.`));
            return;
        }

        // Show warning about what will be deleted
        console.log(chalk.red('\n⚠️  WARNING: This action cannot be undone!'));
        console.log(chalk.gray('This will delete:'));
        console.log(chalk.gray('  • The work record from the database'));
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
        console.log(chalk.gray('Work to delete:'), chalk.white(work.slug));
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
                message: `Type "${work.slug}" to confirm deletion:`,
                validate: (input) => {
                    if (input !== work.slug) {
                        return `You must type "${work.slug}" exactly to confirm`;
                    }
                    return true;
                },
            },
        ]);

        const finalConfirmation = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: chalk.red('Are you absolutely sure you want to delete this work?'),
                default: false,
            },
        ]);

        if (!finalConfirmation.proceed) {
            console.log(chalk.yellow('\nOperation cancelled.'));
            return;
        }

        // Delete work
        const spinner = ora('Deleting work...').start();

        try {
            const deleteDto = {
                reason: deleteOptions.reason || undefined,
                force_delete: deleteOptions.force_delete,
                delete_data_repository: deleteOptions.delete_data_repository,
                delete_markdown_repository: deleteOptions.delete_markdown_repository,
                delete_website_repository: deleteOptions.delete_website_repository,
            };

            const response = await apiService.deleteWork(work.id, deleteDto);

            if (response.status === 'error') {
                spinner.fail('Work deletion failed');
            } else {
                spinner.succeed('Work deleted successfully!');
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
                    console.log(chalk.gray(`  • ${work.owner}/${work.slug}-data`));
                }
                if (!deleteOptions.delete_website_repository) {
                    console.log(chalk.gray(`  • ${work.owner}/${work.slug}-website`));
                }
            }
        } catch (error) {
            spinner.fail('Work deletion failed');
            throw error;
        }
    } catch (error) {
        handleCliError(error);

        process.exit(1);
    }
});
