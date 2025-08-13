import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';

export const regenerateMarkdownCommand = new Command('regenerate-markdown')
    .description('Regenerate readme markdown file for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nRegenerate Markdown Files\n'));

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

            // Show information about what will happen
            console.log(chalk.cyan('\n--- Markdown Regeneration Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Regenerate the README.md file for the directory'));
            console.log(chalk.gray('  • Update the data repository with new markdown content'));
            console.log(chalk.gray('  • Preserve existing data while updating the presentation'));

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with markdown regeneration?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Markdown regeneration cancelled.'));
                return;
            }

            // Regenerate markdown
            const spinner = ora('Regenerating markdown...').start();

            try {
                const response = await apiService.regenerateMarkdown(directory.id);

                spinner.stop();

                if (response.status === 'error') {
                    console.log(
                        chalk.red('\n✗ Markdown regeneration failed'),
                        response.error_details,
                    );
                } else {
                    console.log(chalk.green('\n✓ Markdown regeneration completed successfully!'));
                }

                console.log(chalk.gray('Status:'), chalk.white(response.status));

                if (response.error_details) {
                    console.log(chalk.yellow('\n⚠ Warning:'), chalk.white(response.error_details));
                }

                if (response.status !== 'error') {
                    console.log(chalk.cyan('\nNext Steps:'));
                    console.log(
                        chalk.gray('  • Check your data repository for the updated README.md'),
                    );
                    console.log(chalk.gray('  • Review the changes and commit if satisfied'));
                    console.log(
                        chalk.gray('  • Use "directory update-website" to update the website'),
                    );
                }
            } catch (error) {
                spinner.fail('Markdown regeneration failed');
                throw error;
            }
        } catch (error) {
            console.error(
                chalk.red('\n✗ Failed to regenerate markdown:'),
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
