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
import { Work, WorkPromptService, GenerateStatusType, canEdit } from './work-prompt.service';
import { handleCliError } from '../../utils/error';

export const deployCommand = new Command('deploy')
    .description('Deploy the website for a work')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nDeploy Website\n'));

            // Step 1: Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const workPrompt = new WorkPromptService();

            // Step 2: Select work
            const selection = await workPrompt.promptWorkSelection();
            if (selection.cancelled || !selection.work) {
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected work: ${workPrompt.formatSelectedWork(selection.work, role, isShared)}`,
                ),
            );

            if (!canEdit(role)) {
                console.log(chalk.yellow('\n⚠ You do not have permission to perform this action.'));
                console.log(chalk.gray(`  Your role: ${role}. Required: editor or higher.`));
                return;
            }

            // Step 3: Parallel fetch — fresh work, deploy capability, deploy providers
            const checkSpinner = ora('Checking deployment status...').start();

            let work: Work;
            let deployCheck: DeployCapabilityResponse;
            let deployProviders: DeployProviderInfo[] = [];

            try {
                const [workResult, capabilityResult, providersResult] = await Promise.all([
                    apiService.getWork(selection.work.id),
                    apiService.checkDeployCapability(selection.work.id),
                    apiService
                        .getDeployProviders()
                        .catch(() => ({ status: 'error', providers: [] })),
                ]);

                work = workResult.work;
                deployCheck = capabilityResult;
                deployProviders = providersResult.providers || [];
                checkSpinner.stop();
            } catch (error: any) {
                checkSpinner.fail('Failed to check deployment status');
                throw error;
            }

            // Step 4: generateStatus check
            if (work.generateStatus?.status !== GenerateStatusType.GENERATED) {
                console.log(chalk.yellow('\n⚠ Work content must be generated before deploying.'));
                console.log(chalk.gray("  Use 'work generate' first."));
                return;
            }

            // Step 5: State branching on deployProvider + canDeploy + isShared

            // STATE A — No deploy provider set
            if (!work.deployProvider) {
                console.log(
                    chalk.yellow('\n⚠ No deployment provider is configured for this work.'),
                );

                if (deployProviders.length === 0) {
                    console.log(
                        chalk.gray(
                            '  No deploy providers found. Configure one in Settings > Plugins.',
                        ),
                    );
                    return;
                }

                const selectedProvider = await workPrompt.promptDeployProviderSelection(
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

                // Patch work with selected deploy provider
                const patchSpinner = ora('Setting deploy provider...').start();
                try {
                    const patchResult = await apiService.patchWork(work.id, {
                        deployProvider: selectedProvider,
                    });
                    work = patchResult.work;
                    patchSpinner.succeed(
                        `Deploy provider set to ${chalk.white(getProviderName(selectedProvider, deployProviders))}`,
                    );
                } catch (error: any) {
                    patchSpinner.fail('Failed to set deploy provider');
                    throw error;
                }

                // Re-check capability after setting provider
                try {
                    deployCheck = await apiService.checkDeployCapability(work.id);
                } catch {
                    // If check fails, fall through — executeDeploy will handle errors
                }

                if (!deployCheck.canDeploy) {
                    // Fall through to State B/C logic
                    showTokenMessage(work, deployCheck, deployProviders);
                    return;
                }

                // Provider set and can deploy — proceed to State D
                await executeDeploy(apiService, work, deployProviders);
                return;
            }

            // STATE B — Has provider, can't deploy, shared work
            if (!deployCheck.canDeploy && deployCheck.isShared) {
                const providerName = getProviderName(work.deployProvider, deployProviders);
                console.log(chalk.gray(`\nDeploy provider: ${chalk.white(providerName)}`));
                console.log(
                    chalk.yellow(
                        `\n⚠ The work owner needs to configure their ${providerName} token in Settings > Plugins.`,
                    ),
                );
                return;
            }

            // STATE C — Has provider, can't deploy, owned work
            if (!deployCheck.canDeploy && !deployCheck.isShared) {
                const providerName = getProviderName(work.deployProvider, deployProviders);
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
                        const selectedProvider = await workPrompt.promptDeployProviderSelection(
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
                            const patchResult = await apiService.patchWork(work.id, {
                                deployProvider: selectedProvider,
                            });
                            work = patchResult.work;
                            patchSpinner.succeed(
                                `Deploy provider set to ${chalk.white(getProviderName(selectedProvider, deployProviders))}`,
                            );
                        } catch (error: any) {
                            patchSpinner.fail('Failed to switch deploy provider');
                            throw error;
                        }

                        // Re-check capability with new provider
                        try {
                            deployCheck = await apiService.checkDeployCapability(work.id);
                        } catch {
                            // Proceed anyway
                        }

                        if (deployCheck.canDeploy) {
                            await executeDeploy(apiService, work, deployProviders);
                            return;
                        }

                        // Still can't deploy with new provider
                        const newProviderName = getProviderName(
                            work.deployProvider!,
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
            await executeDeploy(apiService, work, deployProviders);
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
    work: Work,
    deployProviders: DeployProviderInfo[],
) {
    const providerName = getProviderName(work.deployProvider, deployProviders);
    console.log(chalk.gray(`\nDeploy provider: ${chalk.white(providerName)}`));

    // Lookup existing deployment
    try {
        const lookup = await apiService.lookupExistingDeployment(work.id);
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
        const teamResponse = await apiService.getDeployTeamsForWork(work.id);
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

    const websiteRepo = `${work.slug}-website`;
    console.log(chalk.gray('\nSource repository:'), chalk.white(`${work.owner}/${websiteRepo}`));

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

    try {
        const response = await apiService.deployWebsite(work.id, {
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
        if (response.deploymentId) {
            console.log(chalk.gray('Deployment ID:'), chalk.white(response.deploymentId));
        }
        if (response.repository) {
            console.log(chalk.gray('Repository:'), chalk.white(response.repository));
        }
        if (teamScope) {
            const teamLabel =
                deploymentTeams.find((team) => team.slug === teamScope)?.name || teamScope;
            console.log(chalk.gray('Deployment team:'), chalk.white(teamLabel));
        }

        const STOP_STATES = ['READY', 'ERROR', 'CANCELED', 'TIMEOUT'];

        while (true) {
            const { work: freshWork } = await apiService.getWork(work.id);

            if (isDeploying(freshWork)) {
                spinner.text = `Deployment state: ${freshWork.deploymentState}`;
                await new Promise((resolve) => setTimeout(resolve, 5000));
                continue;
            }

            switch (freshWork.deploymentState) {
                case 'READY':
                    spinner.succeed('Deployment completed successfully');
                    break;
                case 'ERROR':
                    spinner.fail('Deployment failed');
                    if (freshWork.generateStatus?.error) {
                        console.log(chalk.red(`\n✗ ${freshWork.generateStatus.error}`));
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

            if (STOP_STATES.includes(freshWork.deploymentState as any)) {
                console.log(
                    chalk.blue('\nWebsite URL:'),
                    chalk.white(freshWork.website || work.website || 'N/A'),
                );
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    } catch (error) {
        spinner.fail('Deployment failed');
        throw error;
    }
}

function isDeploying(work: Work) {
    const hasDeploymentState = ['INITIALIZING', 'QUEUED', 'BUILDING'].includes(
        work.deploymentState as any,
    );

    const hasStartedAt =
        work.deploymentStartedAt &&
        new Date(work.deploymentStartedAt) > new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

    return Boolean(hasDeploymentState && hasStartedAt);
}

function getProviderName(providerId: string | undefined, providers: DeployProviderInfo[]): string {
    if (!providerId) return 'Unknown';
    const provider = providers.find((p) => p.id === providerId);
    return provider?.name || providerId;
}

function showTokenMessage(
    work: Work,
    deployCheck: DeployCapabilityResponse,
    deployProviders: DeployProviderInfo[],
) {
    const providerName = getProviderName(work.deployProvider, deployProviders);
    console.log(chalk.gray(`\nDeploy provider: ${chalk.white(providerName)}`));

    if (deployCheck.isShared) {
        console.log(
            chalk.yellow(
                `\n⚠ The work owner needs to configure their ${providerName} token in Settings > Plugins.`,
            ),
        );
    } else {
        console.log(
            chalk.yellow(`\n⚠ Configure your ${providerName} token in Settings > Plugins.`),
        );
    }
}
