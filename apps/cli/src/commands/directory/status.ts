import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService, Directory, GenerateStatusType } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';
import {
    getDynamicStepText,
    getDynamicStepProgress,
    getItemsProcessedText,
} from '@ever-works/cli-shared';

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

            const spinner = ora('Fetching directory status...').start();

            // Configuration
            const POLL_INTERVAL = 5000;
            const MAX_POLL_TIME = 30 * 60 * 1000; // 30 minutes max
            const startTime = Date.now();
            let intervalId: NodeJS.Timeout | undefined;
            let pollingComplete = false;

            // Setup cleanup on process termination
            const cleanup = () => {
                if (intervalId) {
                    clearInterval(intervalId);
                    intervalId = undefined;
                }
                if (spinner.isSpinning) {
                    spinner.stop();
                }
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
                        spinner.warn('Status check timed out after 30 minutes');
                        pollingComplete = true;
                        cleanup();
                        return;
                    }

                    const { directory: freshDirectory } = await apiService.getDirectory(
                        directory.id,
                    );

                    const status = freshDirectory.generateStatus?.status;

                    if (status === GenerateStatusType.GENERATED) {
                        spinner.succeed('Generation process finished!');
                        pollingComplete = true;
                        cleanup();
                        printDirectorySummary(freshDirectory);
                        return;
                    }

                    if (status === GenerateStatusType.ERROR) {
                        spinner.fail('Generation failed');
                        if (freshDirectory.generateStatus?.error) {
                            console.log(chalk.red(`Error: ${freshDirectory.generateStatus.error}`));
                        }
                        pollingComplete = true;
                        cleanup();
                        printDirectorySummary(freshDirectory);
                        return;
                    }

                    if (status === GenerateStatusType.CANCELLED) {
                        spinner.warn('Generation cancelled');
                        if (freshDirectory.generateStatus?.error) {
                            console.log(chalk.yellow(freshDirectory.generateStatus.error));
                        }
                        pollingComplete = true;
                        cleanup();
                        printDirectorySummary(freshDirectory);
                        return;
                    }

                    if (status === GenerateStatusType.GENERATING) {
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        const timeStr = `[${Math.floor(elapsed / 60)}m ${elapsed % 60}s]`;

                        if (
                            freshDirectory.generateStatus?.step ||
                            freshDirectory.generateStatus?.stepName
                        ) {
                            const stepText = getDynamicStepText(freshDirectory.generateStatus);
                            const progress = getDynamicStepProgress(freshDirectory.generateStatus);
                            const itemsText = getItemsProcessedText(freshDirectory.generateStatus);
                            const itemsSuffix = itemsText ? ` (${itemsText})` : '';

                            spinner.text = `Generating ${timeStr}: ${stepText}${itemsSuffix} - ${progress}%`;
                        } else {
                            spinner.text = `Generating ${timeStr}...`;
                        }
                        return;
                    }

                    pollingComplete = true;
                    cleanup();
                    console.log(chalk.yellow('\n⚠ No active generation detected.'));
                    printDirectorySummary(freshDirectory);
                } catch (error) {
                    spinner.fail('Failed to fetch directory status');
                    console.error(chalk.red('Error details:'), error);
                    pollingComplete = true;
                    cleanup();
                }
            };

            // Initial check
            await checkStatus();

            // Set up interval for subsequent checks
            if (!pollingComplete) {
                intervalId = setInterval(async () => {
                    await checkStatus();
                    if (pollingComplete && intervalId) {
                        clearInterval(intervalId);
                        intervalId = undefined;
                    }
                }, POLL_INTERVAL);
            }
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });

function formatStatus(status?: string) {
    if (!status) {
        return 'not started';
    }
    return status.toLowerCase();
}

function printDirectorySummary(directory: Directory) {
    console.log('');
    console.log(chalk.gray('Name:'), chalk.white(directory.name));
    console.log(
        chalk.gray('Generation status:'),
        chalk.white(formatStatus(directory.generateStatus?.status)),
    );

    if (directory.generateStatus?.error) {
        console.log(chalk.red(`Generation error: ${directory.generateStatus.error}`));
    }

    if (directory.generateStatus?.step) {
        console.log(
            chalk.gray('Last step:'),
            chalk.white(getDynamicStepText(directory.generateStatus)),
        );
    }

    if (directory.deployProvider) {
        console.log(chalk.gray('Deploy provider:'), chalk.white(directory.deployProvider));
    }

    console.log(
        chalk.gray('Deployment status:'),
        chalk.white(
            directory.deploymentState ? directory.deploymentState.toLowerCase() : 'unknown',
        ),
    );

    if (directory.deploymentStartedAt) {
        console.log(
            chalk.gray('Last deployment:'),
            chalk.white(new Date(directory.deploymentStartedAt).toLocaleString()),
        );
    }

    if (directory.website) {
        console.log(chalk.gray('Website URL:'), chalk.white(directory.website));
    }
}
