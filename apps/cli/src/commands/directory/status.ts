import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';
import {
    GenerateStatusType,
    getStepProgress,
    getStepText,
    ItemsGeneratorStep,
} from '@packages/cli-shared';

export const statusCommand = new Command('status')
    .description('Check the status of a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nDirectory Status\n'));

            await requireAuth();
            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

            const selection = await directoryPrompt.promptDirectorySelection();
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

            const spinner = ora('Fetching directory status...').start();

            // Configuration
            const POLL_INTERVAL = 5000;
            const MAX_POLL_TIME = 30 * 60 * 1000; // 30 minutes max
            const startTime = Date.now();
            let intervalId: NodeJS.Timeout;

            // Setup cleanup on process termination
            const cleanup = () => {
                if (intervalId) {
                    clearInterval(intervalId);
                }
                spinner.stop();
            };

            // Handle Ctrl+C gracefully
            process.on('SIGINT', () => {
                cleanup();
                console.log(chalk.yellow('\n\n⚠ Status check cancelled by user.'));
                process.exit(0);
            });

            process.on('SIGTERM', cleanup);

            const checkStatus = async () => {
                try {
                    // Check if we've exceeded max polling time
                    if (Date.now() - startTime > MAX_POLL_TIME) {
                        spinner.warn('\n⚠ Status check timed out after 30 minutes');
                        cleanup();
                        return;
                    }

                    const { directory: freshDirectory } = await apiService.getDirectory(
                        directory.id,
                    );

                    if (freshDirectory.generateStatus?.status === GenerateStatusType.GENERATED) {
                        spinner.succeed('\n✓ Generation process finished!');
                        cleanup();

                        // Show additional info if available
                        console.log(chalk.cyan('\n--- Generation Complete ---'));
                        console.log(chalk.gray('  • Directory is ready for use'));
                    } else if (freshDirectory.generateStatus?.status === GenerateStatusType.ERROR) {
                        spinner.fail('\n✗ Generation failed');

                        if (freshDirectory.generateStatus?.error) {
                            console.log(chalk.red(`Error: ${freshDirectory.generateStatus.error}`));
                        }
                        cleanup();
                    } else {
                        // Update spinner text with current step
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        const timeStr = `[${Math.floor(elapsed / 60)}m ${elapsed % 60}s]`;

                        if (freshDirectory.generateStatus?.step) {
                            const step = freshDirectory.generateStatus.step as ItemsGeneratorStep;
                            const stepText = getStepText(step);
                            const progress = getStepProgress(step);

                            spinner.text = `Generating ${timeStr}: ${stepText} - ${progress}%`;
                        } else {
                            spinner.text = `Generating ${timeStr}...`;
                        }
                    }
                } catch (error) {
                    spinner.fail('Failed to fetch directory status');
                    console.error(chalk.red('Error details:'), error);
                    cleanup();
                }
            };

            // Initial check
            await checkStatus();

            // Set up interval for subsequent checks
            intervalId = setInterval(checkStatus, POLL_INTERVAL);
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });
