import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { GithubService } from '@packages/agent/git';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';
import { DirectoryLifecycleService } from '@packages/agent/services';
import { RepoProvider } from '@packages/agent/dto';

@SubCommand({
    name: 'create',
    description: 'Create a new directory',
})
export class CreateSubCommand extends CommandRunner {
    constructor(
        private readonly directoryLifecycleService: DirectoryLifecycleService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly githubService: GithubService,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nCreate New Directory\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Show loading message
            const loadingSpinner = ora('Loading...').start();

            // Get user information
            const user = await this.userRepository.createOrGetLocalUser();
            const token = user.getGitToken();
            if (!token) {
                throw new Error('GitHub token is required');
            }

            const ghOwner = await this.githubService.getUser(token);

            const orgs = await this.githubService
                .getOrganizations(token)
                .then((orgs) => {
                    const values: { name: string; value: string | null }[] = orgs.map((org) => ({
                        name: org.login,
                        value: org.login,
                    }));
                    values.unshift({ name: 'Personal Account', value: null });
                    return values;
                })
                .catch(() => [{ name: 'Personal Account', value: null }]);

            loadingSpinner.stop();

            // Collect directory information
            const directoryData = await this.directoryPrompt.promptDirectoryCreation(
                ghOwner.login,
                orgs,
            );

            // Determine owner
            const owner = directoryData.owner || ghOwner.login;
            const organization = !!directoryData.owner && directoryData.owner !== ghOwner.login;

            // Check if directory already exists and handle conflicts
            const finalSlug = await this.getFinalSlug(owner, directoryData.slug);
            if (!finalSlug) {
                return;
            }

            // Create directory
            const createSpinner = ora('Creating directory...').start();

            const finalDirectoryData = {
                slug: finalSlug,
                name: directoryData.name,
                description: directoryData.description,
                readmeConfig: directoryData.readmeConfig,
                owner,
                organization,
                repoProvider: RepoProvider.GITHUB,
            };

            const { directory } = await this.directoryLifecycleService.createDirectory(
                finalDirectoryData,
                user,
            );

            createSpinner.stop();

            // Display success information
            console.log(chalk.green('\n✓ Directory created successfully!'));
            console.log(chalk.gray('\nDirectory Details:'));
            console.log(chalk.gray(`  Slug: ${directory.slug}`));
            console.log(chalk.gray(`  Name: ${directory.name}`));
            console.log(chalk.gray(`  Description: ${directory.description}`));
            console.log(chalk.gray(`  Owner: ${directory.getRepoOwner()}`));
            console.log(chalk.gray(`  Organization: ${directory.organization ? 'Yes' : 'No'}`));

            if (directory.readmeConfig) {
                console.log(chalk.gray(`  README Config: Configured`));
            }

            console.log(chalk.cyan('\nNext Steps:'));
            console.log(
                chalk.gray('  • Use ') +
                    chalk.cyan('directory generate') +
                    chalk.gray(' to generate content for your directory.'),
            );
            console.log(chalk.gray('  • Start adding content to your new directory'));
        } catch (error) {
            handleCliError(error, 'Failed to create directory');
            process.exit(1);
        }
    }

    private async getFinalSlug(owner: string, slug: string): Promise<string | null> {
        let slugExists = await this.directoryRepository.findByOwnerAndSlug(owner, slug);

        if (slugExists) {
            // Generate a suggested alternative slug
            const suggestedSlug = await this.generateAvailableSlug(owner, slug);

            // Prompt user for conflict resolution
            const resolution = await this.directoryPrompt.promptSlugConflictResolution(
                slug,
                suggestedSlug,
            );

            if (resolution.action === 'cancel') {
                console.log(chalk.blue('\nℹ Directory creation cancelled.'));
                return null;
            } else if (resolution.action === 'use_suggested') {
                slug = suggestedSlug;
            } else if (resolution.action === 'modify' && resolution.finalSlug) {
                // Check if the manually entered slug is available
                const manualSlugExists = await this.directoryRepository.findByOwnerAndSlug(
                    owner,
                    resolution.finalSlug,
                );
                if (manualSlugExists) {
                    console.log(chalk.red(`\n✗ The slug "${resolution.finalSlug}" is also taken.`));
                    console.log(chalk.blue('Please run the command again with a different name.'));
                    return null;
                }

                slug = resolution.finalSlug;
            }

            console.log(chalk.green(`✓ Using slug: "${slug}"`));
        }

        return slug;
    }

    private async generateAvailableSlug(owner: string, baseSlug: string): Promise<string> {
        let counter = 1;
        let suggestedSlug = `${baseSlug}-${counter}`;

        while (await this.directoryRepository.findByOwnerAndSlug(owner, suggestedSlug)) {
            counter++;
            suggestedSlug = `${baseSlug}-${counter}`;
        }

        return suggestedSlug;
    }
}
