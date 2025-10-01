import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { Directory, DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

interface DeployDto {
    VERCEL_TOKEN?: string;
    GITHUB_TOKEN?: string;
}

export const deployCommand = new Command('deploy')
    .description('Deploy the website for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🚀 Deploy Website\n'));

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
            console.log(chalk.cyan('\n--- Deployment Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Trigger the deployment workflow'));
            console.log(chalk.gray('  • Deploy the website to Vercel'));

            const websiteRepo = `${directory.slug}-website`;
            console.log(
                chalk.gray('\nSource repository:'),
                chalk.white(`${directory.owner}/${websiteRepo}`),
            );

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with deployment?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Deployment cancelled.'));
                return;
            }

            // Deploy website
            const spinner = ora('Deploying website...').start();
            let timeoutId: NodeJS.Timeout | null = null;

            try {
                await apiService.deployWebsite(directory.id);

                console.log(chalk.green('\n✓ Deployment started successfully!'));

                const watchDeployment = async () => {
                    const { directory: freshDirectory } = await apiService.getDirectory(
                        directory.id,
                    );

                    if (isDeploying(freshDirectory)) {
                        spinner.text = `Deployment state: ${freshDirectory.deploymentState}`;

                        timeoutId = setTimeout(watchDeployment, 5000);
                    } else {
                        switch (freshDirectory.deploymentState) {
                            case 'READY':
                                spinner.succeed('Deployment completed successfully');
                                break;
                            case 'ERROR':
                                spinner.fail('Deployment failed');
                                break;
                            case 'CANCELED':
                                spinner.warn('Deployment cancelled');
                                break;
                            case 'TIMEOUT':
                                spinner.fail('Deployment timed out');
                                break;
                            case 'QUEUED':
                                spinner.text = 'Deployment queued...';
                                break;
                            case 'BUILDING':
                                spinner.text = 'Deployment in progress...';
                                break;

                            default:
                                spinner.stop();
                                break;
                        }

                        if (timeoutId) {
                            clearTimeout(timeoutId);
                        }

                        const STOP_STEPS = ['READY', 'ERROR', 'CANCELED', 'TIMEOUT'];
                        if (STOP_STEPS.includes(freshDirectory.deploymentState as any)) {
                            console.log(
                                chalk.blue('\nWebsite URL:'),
                                chalk.white(directory.website),
                            );
                            return;
                        }
                    }
                };

                watchDeployment();
            } catch (error) {
                spinner.fail('Deployment failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            if (error.response?.status === 400) {
                console.log(
                    chalk.yellow(
                        '\n⚠ Invalid deployment configuration. Please check your tokens and try again.',
                    ),
                );
            }

            process.exit(1);
        }
    });

function isDeploying(directory: Directory) {
    const hasDeploymentState = ['INITIALIZING', 'QUEUED', 'BUILDING'].includes(
        directory.deploymentState as any,
    );

    const hasStartedAt =
        directory.deploymentStartedAt &&
        new Date(directory.deploymentStartedAt) > new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

    return Boolean(hasDeploymentState && hasStartedAt);
}
