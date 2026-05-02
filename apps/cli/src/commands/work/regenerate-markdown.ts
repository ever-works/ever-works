import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { WorkPromptService, canEdit } from './work-prompt.service';
import { handleCliError } from '../../utils/error';

export const regenerateMarkdownCommand = new Command('regenerate-markdown')
    .description('Regenerate readme markdown file for a work')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nRegenerate Markdown Files\n'));

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

            if (!canEdit(role)) {
                console.log(chalk.yellow('\n⚠ You do not have permission to perform this action.'));
                console.log(chalk.gray(`  Your role: ${role}. Required: editor or higher.`));
                return;
            }

            // Show information about what will happen
            console.log('');
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Regenerate the README.md file for the work'));
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
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            // Regenerate markdown
            const spinner = ora('Regenerating markdown...').start();

            try {
                const response = await apiService.regenerateMarkdown(work.id);

                if (response.status === 'error') {
                    spinner.fail('Markdown regeneration failed');
                } else {
                    spinner.succeed('Markdown regeneration completed successfully!');
                }

                console.log(chalk.gray('Status:'), chalk.white(response.status));

                if (response.message) {
                    console.log(chalk.yellow('\n⚠ Warning:'), chalk.white(response.message));
                }

                if (response.status !== 'error') {
                    console.log(chalk.cyan('\nNext Steps:'));
                    console.log(
                        chalk.gray('  • Check your data repository for the updated README.md'),
                    );
                    console.log(chalk.gray('  • Review the changes and commit if satisfied'));
                    console.log(chalk.gray('  • Use "work update-website" to update the website'));
                }
            } catch (error) {
                spinner.fail('Markdown regeneration failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
