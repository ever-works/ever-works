import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, DeploymentTeam } from '../../services/api.service';
import { Directory, DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

export const deployCommand = new Command('deploy')
    .description('Deploy the website for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nDeploy Website\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

            // Select directory
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

            // Check if deployment is possible for this directory
            try {
                const deployCheck = await apiService.checkDeployCapability(directory.id);

                if (!deployCheck.canDeploy) {
                    console.log(
                        chalk.yellow('\n⚠ Deployment is not configured for this directory.'),
                    );
                    if (!deployCheck.ownerHasToken) {
                        console.log(
                            chalk.gray(
                                '  The directory owner needs to configure a deployment token in Settings > Plugins.',
                            ),
                        );
                    }
                    if (deployCheck.isShared && !deployCheck.userHasToken) {
                        console.log(
                            chalk.gray(
                                '  You can also configure your own deployment token in Settings > Plugins.',
                            ),
                        );
                    }
                    return;
                }
            } catch (error: any) {
                const message = error?.response?.data?.message || error?.message;
                if (message) {
                    console.log(
                        chalk.yellow(
                            `\n⚠ Could not verify deployment capability (${message}). Attempting to proceed.`,
                        ),
                    );
                }
            }

            // Fetch deployment teams for this directory
            let deploymentTeams: DeploymentTeam[] = [];
            let teamScope: string | undefined;
            try {
                const teamResponse = await apiService.getDeployTeamsForDirectory(directory.id);
                if (teamResponse.status === 'success' && Array.isArray(teamResponse.teams)) {
                    deploymentTeams = teamResponse.teams;
                }
            } catch (error: any) {
                const message = error?.response?.data?.message || error?.message;
                if (message) {
                    console.log(
                        chalk.yellow(
                            `\n⚠ Could not retrieve deployment teams (${message}). Continuing without team selection.`,
                        ),
                    );
                } else {
                    console.log(
                        chalk.yellow(
                            '\n⚠ Could not retrieve deployment teams. Continuing without team selection.',
                        ),
                    );
                }
            }

            if (deploymentTeams.length > 0) {
                console.log('');
                const choices = deploymentTeams.map((team) => ({
                    name: team.name ? `${team.name} (${team.slug})` : team.slug,
                    value: team.slug,
                }));

                const { selectedTeamScope } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'selectedTeamScope',
                        message: 'Select the team to deploy to:',
                        choices,
                        loop: false,
                    },
                ]);

                teamScope = selectedTeamScope;
                const selectedChoice = choices.find((c) => c.value === teamScope);
                console.log(
                    chalk.green(
                        `\n✓ Selected deployment team: ${selectedChoice?.name || teamScope}`,
                    ),
                );
            }

            // Show information about what will happen
            console.log('');
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Trigger the deployment workflow'));
            console.log(chalk.gray('  • Deploy the website'));

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
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            // Deploy website
            const spinner = ora('Deploying website...').start();
            let timeoutId: NodeJS.Timeout | null = null;

            try {
                const response = await apiService.deployWebsite(directory.id, {
                    teamScope,
                });

                if (response.status === 'error') {
                    spinner.fail('Deployment failed to start');
                    const message = response.message || 'The API returned an error status.';
                    console.log(chalk.red(`\n✗ ${message}`));
                    if (response.message?.toLowerCase().includes('token')) {
                        console.log(
                            chalk.gray(
                                'Hint: ensure your deployment token is configured in Plugin Settings.',
                            ),
                        );
                    }
                    return;
                }

                console.log(chalk.green('\n✓ Deployment request accepted!'));
                if (teamScope) {
                    const teamLabel =
                        deploymentTeams.find((team) => team.slug === teamScope)?.name || teamScope;
                    console.log(chalk.gray('Deployment team:'), chalk.white(teamLabel));
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
                    chalk.yellow('\n⚠ Deployment failed. Please verify your setup and try again.'),
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
