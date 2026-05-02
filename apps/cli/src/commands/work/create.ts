import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import {
    getApiService,
    CreateWorkDto,
    GitProviderConnectionInfo,
} from '../../services/api.service';
import { WorkPromptService, GitProviderChoice, DeployProviderChoice } from './work-prompt.service';
import { handleCliError } from '../../utils/error';
import { WEB_URL } from '../../utils/constants';

/**
 * Reconcile owner/organization fields against the git connection info.
 * Ported from web: apps/web/src/app/actions/dashboard/works.ts
 */
function checkOrganization(
    connectionInfo: GitProviderConnectionInfo | null,
    data: { owner?: string; organization?: boolean },
): { organization: boolean; owner: string | undefined } {
    if (!connectionInfo?.connected) {
        return {
            organization: data.organization || false,
            owner: data.owner || undefined,
        };
    }

    const username = connectionInfo.username;

    if (!data.organization) {
        return { organization: false, owner: username || undefined };
    }

    const owner = data.owner?.trim();

    if (owner && username && owner !== username) {
        return { organization: true, owner: owner || undefined };
    }

    return { organization: false, owner: username || undefined };
}

export const createCommand = new Command('create')
    .description('Create a new work')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nCreate New Work\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const workPrompt = new WorkPromptService();

            // 1. Fetch git providers and deploy providers in parallel
            const providerSpinner = ora('Fetching providers...').start();

            const [gitProvidersResponse, deployProvidersResponse] = await Promise.all([
                apiService.getGitProviders(),
                apiService.getDeployProviders().catch(() => ({ status: 'error', providers: [] })),
            ]);

            if (gitProvidersResponse.providers.length === 0) {
                providerSpinner.fail('No git providers available');
                console.log(
                    chalk.yellow(
                        '\nNo git providers are configured. Please configure a git provider in Settings > Plugins.\n',
                    ),
                );
                return;
            }

            // 2. Check connections for all git providers in parallel
            const connectionResults = await Promise.all(
                gitProvidersResponse.providers.map(async (provider) => {
                    try {
                        const connection = await apiService.checkGitProviderConnection(provider.id);
                        return {
                            id: provider.id,
                            name: provider.name,
                            enabled: provider.enabled,
                            connected: connection.connected,
                            username: connection.username,
                            connectionInfo: connection,
                        };
                    } catch {
                        return {
                            id: provider.id,
                            name: provider.name,
                            enabled: provider.enabled,
                            connected: false,
                            username: undefined,
                            connectionInfo: null,
                        };
                    }
                }),
            );

            providerSpinner.succeed('Providers loaded');

            const hasEnabledProvider = connectionResults.some((p) => p.enabled);
            if (!hasEnabledProvider) {
                console.log(
                    chalk.yellow(
                        '\nNo git providers are enabled. Please configure a git provider in Settings > Plugins.\n',
                    ),
                );
                return;
            }

            // 3. Prompt for git provider selection
            const gitProviderChoices: GitProviderChoice[] = connectionResults.map((p) => ({
                id: p.id,
                name: p.name,
                enabled: p.enabled,
                connected: p.connected,
                username: p.username,
            }));

            const selectedGitProviderId =
                await workPrompt.promptGitProviderSelection(gitProviderChoices);

            // 4. Verify selected provider is connected
            const selectedProviderInfo = connectionResults.find(
                (p) => p.id === selectedGitProviderId,
            );
            if (!selectedProviderInfo?.connected) {
                console.log(
                    chalk.yellow(
                        `\nThe selected git provider "${selectedProviderInfo?.name || selectedGitProviderId}" is not connected.\n`,
                    ),
                );
                console.log(
                    chalk.gray('  Go to ') +
                        chalk.cyan(WEB_URL) +
                        chalk.gray(' to connect your git provider account.'),
                );
                return;
            }

            // 5. Prompt for deploy provider selection (skip if none available)
            let selectedDeployProviderId: string | null = null;

            if (deployProvidersResponse.providers.length > 0) {
                const deployProviderChoices: DeployProviderChoice[] =
                    deployProvidersResponse.providers.map((p) => ({
                        id: p.id,
                        name: p.name,
                        enabled: p.enabled,
                    }));

                selectedDeployProviderId =
                    await workPrompt.promptDeployProviderSelection(deployProviderChoices);
            }

            // 6. Get organizations from the selected git provider
            const orgs = await apiService
                .getGitProviderOrganizations(selectedGitProviderId)
                .then((res) => {
                    if (!res.success || !res.organizations?.length) {
                        return [{ name: 'Personal Account', value: null as string | null }];
                    }
                    const values: { name: string; value: string | null }[] = res.organizations.map(
                        (org) => ({
                            name: org.login,
                            value: org.login,
                        }),
                    );
                    values.unshift({ name: 'Personal Account', value: null });
                    return values;
                })
                .catch(() => [{ name: 'Personal Account', value: null as string | null }]);

            // 7. Collect work information (name, slug, description, owner/organization)
            const workData = await workPrompt.promptWorkCreation(undefined, orgs);

            // 8. Reconcile owner/organization with git connection
            const { organization, owner } = checkOrganization(selectedProviderInfo.connectionInfo, {
                owner: workData.owner,
                organization: !!workData.owner,
            });

            // 9. Create work with slug conflict handling
            let finalSlug = workData.slug;
            let conflictResolved = false;
            let increment = 1;

            while (!conflictResolved) {
                const spinner = ora(`Creating work "${finalSlug}"...`).start();

                try {
                    const createWorkDto: CreateWorkDto = {
                        slug: finalSlug,
                        name: workData.name,
                        description: workData.description,
                        owner,
                        organization,
                        gitProvider: selectedGitProviderId,
                        deployProvider: selectedDeployProviderId || undefined,
                    };

                    const response = await apiService.createWork(createWorkDto);

                    spinner.succeed('Work created successfully');
                    conflictResolved = true;

                    console.log(chalk.green('\nWork created successfully!'));
                    console.log(chalk.gray('Work details:'));
                    console.log(chalk.white(`  Name: ${response.work.name}`));
                    console.log(chalk.white(`  Slug: ${response.work.slug}`));
                    console.log(chalk.white(`  Owner: ${response.work.owner}`));
                    console.log(chalk.white(`  Description: ${response.work.description}`));

                    console.log(chalk.cyan('\nNext Steps:'));
                    console.log(
                        chalk.gray('  Use ') +
                            chalk.cyan('work generate') +
                            chalk.gray(' to generate content for your work.'),
                    );
                    console.log(chalk.gray('  Start adding content to your new work'));
                } catch (error) {
                    spinner.stop();

                    // Check if it's a conflict error
                    if (
                        error.response?.status === 409 ||
                        error.message?.includes('already exists')
                    ) {
                        const suggestedSlug = workPrompt.generateIncrementedSlug(
                            workData.slug,
                            increment,
                        );

                        const resolution = await workPrompt.promptSlugConflictResolution(
                            finalSlug,
                            suggestedSlug,
                        );

                        if (resolution.action === 'cancel') {
                            console.log(chalk.yellow('\nWork creation cancelled.'));
                            return;
                        } else if (resolution.action === 'use_suggested') {
                            finalSlug = suggestedSlug;
                            increment++;
                        } else if (resolution.action === 'modify' && resolution.finalSlug) {
                            finalSlug = resolution.finalSlug;
                            increment = 1;
                        }

                        console.log(chalk.green(`Using slug: "${finalSlug}"`));
                    } else {
                        throw error;
                    }
                }
            }
        } catch (error) {
            handleCliError(error);

            if (error.response?.status === 400) {
                console.log(
                    chalk.yellow(
                        '\nInvalid input. Please ensure all required fields are correctly filled.',
                    ),
                );
            }

            process.exit(1);
        }
    });
