import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import {
    getApiService,
    DeploymentTeam,
    DeployCapabilityResponse,
    DeployProviderInfo,
} from '../../services/api.service';
import { Directory, DirectoryPromptService, GenerateStatusType } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';

export const deployCommand = new Command('deploy')
    .description('Deploy the website for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nDeploy Website\n'));

            // Step 1: Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

            // Step 2: Select directory
            const selection = await directoryPrompt.promptDirectorySelection();
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected directory: ${directoryPrompt.formatSelectedDirectory(selection.directory, role, isShared)}`,
                ),
            );

            // Step 3: Parallel fetch — fresh directory, deploy capability, deploy providers
            const checkSpinner = ora('Checking deployment status...').start();

            let directory: Directory;
            let deployCheck: DeployCapabilityResponse;
            let deployProviders: DeployProviderInfo[] = [];

            try {
                const [directoryResult, capabilityResult, providersResult] = await Promise.all([
                    apiService.getDirectory(selection.directory.id),
                    apiService.checkDeployCapability(selection.directory.id),
                    apiService
                        .getDeployProviders()
                        .catch(() => ({ status: 'error', providers: [] })),
                ]);

                directory = directoryResult.directory;
                deployCheck = capabilityResult;
                deployProviders = providersResult.providers || [];
                checkSpinner.stop();
            } catch (error: any) {
                checkSpinner.fail('Failed to check deployment status');
                throw error;
            }

            // Step 4: generateStatus check
            if (directory.generateStatus?.status !== GenerateStatusType.GENERATED) {
                console.log(
                    chalk.yellow('\n⚠ Directory content must be generated before deploying.'),
                );
                console.log(chalk.gray("  Use 'directory generate' first."));
                return;
            }

            // Step 5: State branching on deployProvider + canDeploy + isShared

            // STATE A — No deploy provider set
            if (!directory.deployProvider) {
                console.log(
                    chalk.yellow('\n⚠ No deployment provider is configured for this directory.'),
                );

                if (deployProviders.length === 0) {
                    console.log(
                        chalk.gray(
                            '  No deploy providers found. Configure one in Settings > Plugins.',
                        ),
                    );
                    return;
                }

                const selectedProvider = await directoryPrompt.promptDeployProviderSelection(
                    deployProviders.map((p) => ({
                        id: p.id,
                        name: p.name,
                        enabled: p.enabled,
                    })),
                );

                if (!selectedProvider) {
                    console.log(chalk.yellow('\nDeployment skipped.'));
                    return;
                }

                // Patch directory with selected deploy provider
                const patchSpinner = ora('Setting deploy provider...').start();
                try {
                    const patchResult = await apiService.patchDirectory(directory.id, {
                        deployProvider: selectedProvider,
                    });
                    directory = patchResult.directory;
                    patchSpinner.succeed(
                        `Deploy provider set to ${chalk.white(getProviderName(selectedProvider, deployProviders))}`,
                    );
                } catch (error: any) {
                    patchSpinner.fail('Failed to set deploy provider');
                    throw error;
                }

                // Re-check capability after setting provider
                try {
                    deployCheck = await apiService.checkDeployCapability(directory.id);
                } catch {
                    // If check fails, fall through — executeDeploy will handle errors
                }

                if (!deployCheck.canDeploy) {
                    // Fall through to State B/C logic
                    showTokenMessage(directory, deployCheck, deployProviders);
                    return;
                }

                // Provider set and can deploy — proceed to State D
                await executeDeploy(apiService, directory, deployProviders);
                return;
            }

            // STATE B — Has provider, can't deploy, shared directory
            if (!deployCheck.canDeploy && deployCheck.isShared) {
                const providerName = getProviderName(directory.deployProvider, deployProviders);
                console.log(chalk.gray(`\nDeploy provider: ${chalk.white(providerName)}`));
                console.log(
                    chalk.yellow(
                        `\n⚠ The directory owner needs to configure their ${providerName} token in Settings > Plugins.`,
                    ),
                );
                return;
            }

            // STATE C — Has provider, can't deploy, owned directory
            if (!deployCheck.canDeploy && !deployCheck.isShared) {
                const providerName = getProviderName(directory.deployProvider, deployProviders);
                console.log(chalk.gray(`\nDeploy provider: ${chalk.white(providerName)}`));
                console.log(
                    chalk.yellow(`\n⚠ Configure your ${providerName} token in Settings > Plugins.`),
                );

                if (deployProviders.length > 0) {
                    const { switchProvider } = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'switchProvider',
                            message: 'Would you like to switch deploy provider?',
                            default: false,
                        },
                    ]);

                    if (switchProvider) {
                        const selectedProvider =
                            await directoryPrompt.promptDeployProviderSelection(
                                deployProviders.map((p) => ({
                                    id: p.id,
                                    name: p.name,
                                    enabled: p.enabled,
                                })),
                            );

                        if (!selectedProvider) {
                            console.log(chalk.yellow('\nDeployment skipped.'));
                            return;
                        }

                        const patchSpinner = ora('Switching deploy provider...').start();
                        try {
                            const patchResult = await apiService.patchDirectory(directory.id, {
                                deployProvider: selectedProvider,
                            });
                            directory = patchResult.directory;
                            patchSpinner.succeed(
                                `Deploy provider set to ${chalk.white(getProviderName(selectedProvider, deployProviders))}`,
                            );
                        } catch (error: any) {
                            patchSpinner.fail('Failed to switch deploy provider');
                            throw error;
                        }

                        // Re-check capability with new provider
                        try {
                            deployCheck = await apiService.checkDeployCapability(directory.id);
                        } catch {
                            // Proceed anyway
                        }

                        if (deployCheck.canDeploy) {
                            await executeDeploy(apiService, directory, deployProviders);
                            return;
                        }

                        // Still can't deploy with new provider
                        const newProviderName = getProviderName(
                            directory.deployProvider!,
                            deployProviders,
                        );
                        console.log(
                            chalk.yellow(
                                `\n⚠ Configure your ${newProviderName} token in Settings > Plugins.`,
                            ),
                        );
                    }
                }
                return;
            }

            // STATE D — Has provider, can deploy
            await executeDeploy(apiService, directory, deployProviders);
        } catch (error: any) {
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

/**
 * Executes the deployment flow (State D):
 * lookup existing deployment → team selection → confirm → deploy → poll
 */
async function executeDeploy(
    apiService: ReturnType<typeof getApiService>,
    directory: Directory,
    deployProviders: DeployProviderInfo[],
) {
    const providerName = getProviderName(directory.deployProvider, deployProviders);
    console.log(chalk.gray(`\nDeploy provider: ${chalk.white(providerName)}`));

    // Lookup existing deployment
    try {
        const lookup = await apiService.lookupExistingDeployment(directory.id);
        if (lookup.found && lookup.website) {
            console.log(chalk.gray('Existing deployment:'), chalk.white(lookup.website));
        }
    } catch {
        // Swallowed — same as web
    }

    // Fetch deployment teams
    let deploymentTeams: DeploymentTeam[] = [];
    let teamScope: string | undefined;

    try {
        const teamResponse = await apiService.getDeployTeamsForDirectory(directory.id);
        if (teamResponse.status === 'success' && Array.isArray(teamResponse.teams)) {
            deploymentTeams = teamResponse.teams;
        }
    } catch {
        // Continue without team selection
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
            chalk.green(`\n✓ Selected deployment team: ${selectedChoice?.name || teamScope}`),
        );
    }

    // Deploy summary and confirmation
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
            const message = (response as any).message || 'The API returned an error status.';
            console.log(chalk.red(`\n✗ ${message}`));
            if ((response as any).message?.toLowerCase().includes('token')) {
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
            const { directory: freshDirectory } = await apiService.getDirectory(directory.id);

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
                            console.log(chalk.red(`\n✗ ${freshDirectory.generateStatus.error}`));
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
}

function isDeploying(directory: Directory) {
    const hasDeploymentState = ['INITIALIZING', 'QUEUED', 'BUILDING'].includes(
        directory.deploymentState as any,
    );

    const hasStartedAt =
        directory.deploymentStartedAt &&
        new Date(directory.deploymentStartedAt) > new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

    return Boolean(hasDeploymentState && hasStartedAt);
}

function getProviderName(providerId: string | undefined, providers: DeployProviderInfo[]): string {
    if (!providerId) return 'Unknown';
    const provider = providers.find((p) => p.id === providerId);
    return provider?.name || providerId;
}

function showTokenMessage(
    directory: Directory,
    deployCheck: DeployCapabilityResponse,
    deployProviders: DeployProviderInfo[],
) {
    const providerName = getProviderName(directory.deployProvider, deployProviders);
    console.log(chalk.gray(`\nDeploy provider: ${chalk.white(providerName)}`));

    if (deployCheck.isShared) {
        console.log(
            chalk.yellow(
                `\n⚠ The directory owner needs to configure their ${providerName} token in Settings > Plugins.`,
            ),
        );
    } else {
        console.log(
            chalk.yellow(`\n⚠ Configure your ${providerName} token in Settings > Plugins.`),
        );
    }
}
