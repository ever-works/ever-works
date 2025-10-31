import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, VercelTeam } from '../../services/api.service';
import { Directory, DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

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

            // Attempt to fetch Vercel teams (optional)
            let vercelTeams: VercelTeam[] = [];
            let vercelTeamScope: string | undefined;
            try {
                const teamResponse = await apiService.getVercelTeams();
                if (teamResponse.status === 'success' && Array.isArray(teamResponse.teams)) {
                    vercelTeams = teamResponse.teams;
                }
            } catch (error: any) {
                const message = error?.response?.data?.message || error?.message;
                if (message) {
                    console.log(
                        chalk.yellow(
                            `\n⚠ Could not retrieve Vercel teams (${message}). Continuing without team selection.`,
                        ),
                    );
                } else {
                    console.log(
                        chalk.yellow(
                            '\n⚠ Could not retrieve Vercel teams. Continuing without team selection.',
                        ),
                    );
                }
            }

            if (vercelTeams.length > 0) {
                console.log(chalk.cyan('\n--- Vercel Team Selection ---'));
                const choices = vercelTeams.map((team) => ({
                    name: team.name ? `${team.name} (${team.slug})` : team.slug,
                    value: team.slug,
                }));

                const { selectedTeamScope } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'selectedTeamScope',
                        message: 'Select the Vercel team to deploy to:',
                        choices,
                        loop: false,
                    },
                ]);

                vercelTeamScope = selectedTeamScope;
                const selectedChoice = choices.find((c) => c.value === vercelTeamScope);
                console.log(
                    chalk.green(
                        `\n✓ Selected Vercel team: ${selectedChoice?.name || vercelTeamScope}`,
                    ),
                );
            }

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
                const response = await apiService.deployWebsite(directory.id, {
                    vercelTeamScope,
                });

                if (response.status === 'error') {
                    spinner.fail('Deployment failed to start');
                    const message = response.message || 'The API returned an error status.';
                    console.log(chalk.red(`\n✗ ${message}`));
                    if (response.message?.toLowerCase().includes('token')) {
                        console.log(
                            chalk.gray(
                                'Hint: ensure your Vercel token is configured (`ever-works auth tokens`).',
                            ),
                        );
                    }
                    return;
                }

                console.log(chalk.green('\n✓ Deployment request accepted!'));
                if (vercelTeamScope) {
                    const teamLabel =
                        vercelTeams.find((team) => team.slug === vercelTeamScope)?.name ||
                        vercelTeamScope;
                    console.log(chalk.gray('Vercel team:'), chalk.white(teamLabel));
                }

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
                                if (freshDirectory.generateStatus?.error) {
                                    console.log(
                                        chalk.red(`\n✗ ${freshDirectory.generateStatus.error}`),
                                    );
                                }
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
                                chalk.white(freshDirectory.website || directory.website || 'N/A'),
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
                        '\n⚠ Deployment failed. Please verify your Vercel setup and try again.',
                    ),
                );
                const message = error.response?.data?.message;
                if (message) {
                    console.log(chalk.gray(`Details: ${message}`));
                }
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
