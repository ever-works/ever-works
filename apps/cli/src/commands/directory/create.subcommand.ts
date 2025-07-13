import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import { DirectoryRepository, GithubService, User } from '@packages/agent';
import { DirectoryPromptService } from './directory-prompt.service';

@SubCommand({
    name: 'create',
    description: 'Create a new directory',
})
export class CreateSubCommand extends CommandRunner {
    private readonly logger = new Logger(CreateSubCommand.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly githubService: GithubService,
        private readonly directoryPrompt: DirectoryPromptService,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n📁 Create New Directory\n'));

            // Show loading message
            const loadingSpinner = ora('Loading...').start();

            // Get user information
            const user = await User.sessionMock();
            const ghOwner = await this.githubService.getUser(user.getGitToken());

            loadingSpinner.stop();

            // Collect directory information
            const directoryData = await this.directoryPrompt.promptDirectoryCreation(ghOwner.login);

            // Determine owner
            const owner = directoryData.owner || ghOwner.login;
            const organization = !!directoryData.owner && directoryData.owner !== ghOwner.login;

            // Check if directory already exists and handle conflicts
            const spinner = ora('Checking if directory exists...').start();
            let finalSlug = directoryData.slug;
            let slugExists = await this.directoryRepository.existsByOwnerAndSlug(owner, finalSlug);

            if (slugExists) {
                spinner.stop();

                // Generate a suggested alternative slug
                const suggestedSlug = await this.generateAvailableSlug(owner, directoryData.slug);

                // Prompt user for conflict resolution
                const resolution = await this.directoryPrompt.promptSlugConflictResolution(
                    directoryData.slug,
                    suggestedSlug,
                );

                if (resolution.action === 'cancel') {
                    console.log(chalk.blue('\nℹ Directory creation cancelled.'));
                    return;
                } else if (resolution.action === 'use_suggested') {
                    finalSlug = suggestedSlug;
                } else if (resolution.action === 'modify' && resolution.finalSlug) {
                    // Check if the manually entered slug is available
                    const manualSlugExists = await this.directoryRepository.existsByOwnerAndSlug(
                        owner,
                        resolution.finalSlug,
                    );
                    if (manualSlugExists) {
                        console.log(
                            chalk.red(`\n✗ The slug "${resolution.finalSlug}" is also taken.`),
                        );
                        console.log(
                            chalk.blue('Please run the command again with a different name.'),
                        );
                        return;
                    }
                    finalSlug = resolution.finalSlug;
                }

                console.log(chalk.green(`✓ Using slug: "${finalSlug}"`));
            } else {
                spinner.succeed('Directory slug is available');
            }

            // Create directory
            const createSpinner = ora('Creating directory...').start();

            const finalDirectoryData = {
                slug: finalSlug,
                name: directoryData.name,
                description: directoryData.description,
                readmeConfig: directoryData.readme_config,
                owner,
                organization,
            };

            const directory = await this.directoryRepository.create(finalDirectoryData);
            createSpinner.succeed('Directory created successfully');

            // Display success information
            console.log(chalk.green('\n✓ Directory created successfully!'));
            console.log(chalk.gray('\nDirectory Details:'));
            console.log(chalk.gray(`  ID: ${directory.id}`));
            console.log(chalk.gray(`  Slug: ${directory.slug}`));
            console.log(chalk.gray(`  Name: ${directory.name}`));
            console.log(chalk.gray(`  Description: ${directory.description}`));
            console.log(chalk.gray(`  Owner: ${directory.owner}`));
            console.log(chalk.gray(`  Organization: ${directory.organization ? 'Yes' : 'No'}`));

            if (directory.readmeConfig) {
                console.log(chalk.gray(`  README Config: Configured`));
            }

            console.log(chalk.cyan('\nNext Steps:'));
            console.log(
                chalk.gray('  • Use ') +
                    chalk.cyan('directory list') +
                    chalk.gray(' to see all your directories'),
            );
            console.log(chalk.gray('  • Start adding content to your new directory'));
        } catch (error) {
            this.logger.error('Failed to create directory:', error);
            console.log(chalk.red('\n✗ Failed to create directory:'), error.message);

            if (error.message.includes('Owner is required')) {
                console.log(
                    chalk.yellow('\n⚠ Make sure your GitHub configuration is set up correctly.'),
                );
                console.log(
                    chalk.gray('Run ') +
                        chalk.cyan('ever-works config setup') +
                        chalk.gray(' to configure GitHub settings.'),
                );
            }
        }
    }

    private async generateAvailableSlug(owner: string, baseSlug: string): Promise<string> {
        let counter = 1;
        let suggestedSlug = `${baseSlug}-${counter}`;

        while (await this.directoryRepository.existsByOwnerAndSlug(owner, suggestedSlug)) {
            counter++;
            suggestedSlug = `${baseSlug}-${counter}`;
        }

        return suggestedSlug;
    }
}
