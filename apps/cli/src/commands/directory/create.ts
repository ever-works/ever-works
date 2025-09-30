import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService, CreateDirectoryDto } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';
import { RepoProvider } from '@packages/cli-shared';

export const createCommand = new Command('create')
    .description('Create a new directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nCreate New Directory\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

            const githubConnected = await apiService.checkConnection(RepoProvider.GITHUB);

            if (!githubConnected.connected) {
                console.log(
                    chalk.yellow(
                        '\n⚠ GitHub is not connected. Please connect your GitHub account.\n',
                    ),
                );
            }

            const orgs = await apiService
                .getGitHubOrgs()
                .then((orgs) => {
                    const values: { name: string; value: string | null }[] = orgs.map((org) => ({
                        name: org.login,
                        value: org.login,
                    }));
                    values.unshift({ name: 'Personal Account', value: null });
                    return values;
                })
                .catch(() => [{ name: 'Personal Account', value: null }]);

            // Collect directory information
            const directoryData = await directoryPrompt.promptDirectoryCreation(undefined, orgs);

            // Check for slug conflicts and handle them
            let finalSlug = directoryData.slug;
            let conflictResolved = false;
            let increment = 1;

            while (!conflictResolved) {
                const spinner = ora(`Checking availability of slug: "${finalSlug}"`).start();

                try {
                    // Try to create the directory
                    const createDirectoryDto: CreateDirectoryDto = {
                        slug: finalSlug,
                        name: directoryData.name,
                        description: directoryData.description,
                        readmeConfig: directoryData.readmeConfig,
                        owner: directoryData.owner,
                        organization: !!directoryData.owner,
                    };

                    const response = await apiService.createDirectory(createDirectoryDto);

                    spinner.succeed('Directory created successfully');
                    conflictResolved = true;

                    console.log(chalk.green('\n✓ Directory created successfully!'));
                    console.log(chalk.gray('Directory details:'));
                    console.log(chalk.white(`  Name: ${response.directory.name}`));
                    console.log(chalk.white(`  Slug: ${response.directory.slug}`));
                    console.log(chalk.white(`  Owner: ${response.directory.owner}`));
                    console.log(chalk.white(`  Description: ${response.directory.description}`));

                    console.log(chalk.cyan('\nNext Steps:'));
                    console.log(
                        chalk.gray('  • Use ') +
                            chalk.cyan('directory generate') +
                            chalk.gray(' to generate content for your directory.'),
                    );
                    console.log(chalk.gray('  • Start adding content to your new directory'));
                } catch (error) {
                    spinner.stop();

                    // Check if it's a conflict error (assuming API returns 409 or similar)
                    if (
                        error.response?.status === 409 ||
                        error.message?.includes('already exists')
                    ) {
                        const suggestedSlug = directoryPrompt.generateIncrementedSlug(
                            directoryData.slug,
                            increment,
                        );

                        const resolution = await directoryPrompt.promptSlugConflictResolution(
                            finalSlug,
                            suggestedSlug,
                        );

                        if (resolution.action === 'cancel') {
                            console.log(chalk.yellow('\n⚠ Directory creation cancelled.'));
                            return;
                        } else if (resolution.action === 'use_suggested') {
                            finalSlug = suggestedSlug;
                            increment++;
                        } else if (resolution.action === 'modify' && resolution.finalSlug) {
                            finalSlug = resolution.finalSlug;
                            increment = 1; // Reset increment for new base slug
                        }

                        console.log(chalk.green(`✓ Using slug: "${finalSlug}"`));
                    } else {
                        // Other error
                        throw error;
                    }
                }
            }
        } catch (error) {
            handleCliError(error);

            if (error.response?.status === 400) {
                console.log(
                    chalk.yellow(
                        '\n⚠ Invalid input. Please ensure all required fields are correctly filled.',
                    ),
                );
            }

            process.exit(1);
        }
    });
