import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { WorkPromptService, canEdit } from './work-prompt.service';
import { handleCliError } from '../../utils/error';

export const updateWebsiteCommand = new Command('update-website')
    .description('Update the website repository for a work')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nUpdate Website\n'));

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
            console.log(chalk.gray('  • Update the website repository with latest data'));
            console.log(chalk.gray('  • Sync content from the data repository'));
            console.log(chalk.gray('  • Prepare the website for deployment'));

            const websiteRepo = `${work.slug}-website`;
            console.log(
                chalk.gray('\nTarget repository:'),
                chalk.white(`${work.owner}/${websiteRepo}`),
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
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            // Update website
            const spinner = ora('Updating website repository...').start();

            try {
                const response = await apiService.updateWebsite(work.id);

                if (response.status === 'error') {
                    spinner.fail('Website update failed');
                } else {
                    spinner.succeed('Website updated successfully!');
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
                    console.log(chalk.gray('  • Use "work deploy" to deploy the website'));
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
