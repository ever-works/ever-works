import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { WorkPromptService, Work, GenerateStatusType } from './work-prompt.service';
import { handleCliError } from '../../utils/error';
import {
    getDynamicStepText,
    getDynamicStepProgress,
    getItemsProcessedText,
} from '@ever-works/cli-shared';

export const statusCommand = new Command('status')
    .description('Check the status of a work')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nWork Status\n'));

            await requireAuth();
            const apiService = getApiService();
            const workPrompt = new WorkPromptService();

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

            const spinner = ora('Fetching work status...').start();

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

                    const { work: freshWork } = await apiService.getWork(
                        work.id,
                    );

                    const status = freshWork.generateStatus?.status;

                    if (status === GenerateStatusType.GENERATED) {
                        spinner.succeed('Generation process finished!');
                        pollingComplete = true;
                        cleanup();
                        printWorkSummary(freshWork);
                        return;
                    }

                    if (status === GenerateStatusType.ERROR) {
                        spinner.fail('Generation failed');
                        if (freshWork.generateStatus?.error) {
                            console.log(chalk.red(`Error: ${freshWork.generateStatus.error}`));
                        }
                        pollingComplete = true;
                        cleanup();
                        printWorkSummary(freshWork);
                        return;
                    }

                    if (status === GenerateStatusType.CANCELLED) {
                        spinner.warn('Generation cancelled');
                        if (freshWork.generateStatus?.error) {
                            console.log(chalk.yellow(freshWork.generateStatus.error));
                        }
                        pollingComplete = true;
                        cleanup();
                        printWorkSummary(freshWork);
                        return;
                    }

                    if (status === GenerateStatusType.GENERATING) {
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        const timeStr = `[${Math.floor(elapsed / 60)}m ${elapsed % 60}s]`;

                        if (
                            freshWork.generateStatus?.step ||
                            freshWork.generateStatus?.stepName
                        ) {
                            const stepText = getDynamicStepText(freshWork.generateStatus);
                            const progress = getDynamicStepProgress(freshWork.generateStatus);
                            const itemsText = getItemsProcessedText(freshWork.generateStatus);
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
                    printWorkSummary(freshWork);
                } catch (error) {
                    spinner.fail('Failed to fetch work status');
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

function printWorkSummary(work: Work) {
    console.log('');
    console.log(chalk.gray('Name:'), chalk.white(work.name));
    console.log(
        chalk.gray('Generation status:'),
        chalk.white(formatStatus(work.generateStatus?.status)),
    );

    if (work.generateStatus?.error) {
        console.log(chalk.red(`Generation error: ${work.generateStatus.error}`));
    }

    if (work.generateStatus?.step) {
        console.log(
            chalk.gray('Last step:'),
            chalk.white(getDynamicStepText(work.generateStatus)),
        );
    }

    if (work.deployProvider) {
        console.log(chalk.gray('Deploy provider:'), chalk.white(work.deployProvider));
    }

    console.log(
        chalk.gray('Deployment status:'),
        chalk.white(
            work.deploymentState ? work.deploymentState.toLowerCase() : 'unknown',
        ),
    );

    if (work.deploymentStartedAt) {
        console.log(
            chalk.gray('Last deployment:'),
            chalk.white(new Date(work.deploymentStartedAt).toLocaleString()),
        );
    }

    if (work.website) {
        console.log(chalk.gray('Website URL:'), chalk.white(work.website));
    }
}
