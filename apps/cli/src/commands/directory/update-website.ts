import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

export const updateWebsiteCommand = new Command('update-website')
    .description('Update the website repository for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nUpdate Website\n'));

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
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected directory: ${directoryPrompt.formatSelectedDirectory(directory, role, isShared)}`,
                ),
            );

            // Show information about what will happen
            console.log(chalk.cyan('\n--- Website Update Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Update the website repository with latest data'));
            console.log(chalk.gray('  • Sync content from the data repository'));
            console.log(chalk.gray('  • Prepare the website for deployment'));

            const websiteRepo = `${directory.slug}-website`;
            console.log(
                chalk.gray('\nTarget repository:'),
                chalk.white(`${directory.owner}/${websiteRepo}`),
            );

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with website update?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Website update cancelled.'));
                return;
            }

            // Update website
            const spinner = ora('Updating website repository...').start();

            try {
                const response = await apiService.updateWebsite(directory.id);

                spinner.stop();
                if (response.status === 'error') {
                    console.log(chalk.red('\n✗ Website update failed'));
                } else {
                    console.log(chalk.green('\n✓ Website updated successfully!'));
                }

                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }

                if (response.repository) {
                    console.log(chalk.blue('\nRepository:'), chalk.white(response.repository));
                }

                if (response.status !== 'error') {
                    console.log(chalk.cyan('\nNext Steps:'));
                    console.log(chalk.gray('  • Check the website repository for updates'));
                    console.log(chalk.gray('  • Use "directory deploy" to deploy the website'));
                    console.log(chalk.gray('  • Review the changes before deployment'));
                }
            } catch (error) {
                spinner.fail('Website update failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
