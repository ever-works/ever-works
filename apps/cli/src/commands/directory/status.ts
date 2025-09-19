import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';
import { GenerateStatusType } from '@packages/cli-shared';

export const statusCommand = new Command('status')
    .description('Check the status of a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nDirectory Status\n'));

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

            const spinner = ora('Fetching directory status...').start();

            // watch for status changes
            const watchStatus = async () => {
                const freshDirectory = await apiService
                    .getDirectory(directory.id)
                    .catch(() => null);

                if (!freshDirectory) {
                    spinner.fail('Failed to fetch directory status');
                    return;
                }

                if (freshDirectory.generateStatus?.status === GenerateStatusType.GENERATED) {
                    spinner.succeed('\n✓ Generation process finished!');
                    return;
                } else if (freshDirectory.generateStatus?.status === GenerateStatusType.ERROR) {
                    spinner.fail('\n✗ Generation failed');
                    return;
                }

                if (freshDirectory.generateStatus?.step) {
                    spinner.text = `Generating: ${freshDirectory.generateStatus.step}`;
                } else {
                    spinner.text = `Generating...`;
                }

                setTimeout(watchStatus, 5000);
            };

            watchStatus();
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
