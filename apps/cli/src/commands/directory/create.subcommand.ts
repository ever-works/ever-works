import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import inquirer from 'inquirer';
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

            // Collect directory information
            const directoryData = await this.directoryPrompt.promptDirectoryCreation();

            // Get user information
            const user = await User.sessionMock();
            const ghOwner = await this.githubService.getUser(user.getGitToken());

            // Determine owner
            const owner = directoryData.owner || ghOwner.login;
            const organization = !!directoryData.owner && directoryData.owner !== ghOwner.login;

            // Check if directory already exists
            const spinner = ora('Checking if directory exists...').start();
            const exists = await this.directoryRepository.existsByOwnerAndSlug(
                owner,
                directoryData.slug,
            );

            if (exists) {
                spinner.fail('Directory already exists');
                console.log(
                    chalk.red(
                        `\n✗ A directory with slug "${directoryData.slug}" already exists for owner "${owner}"`,
                    ),
                );

                const { shouldChooseDifferent } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'shouldChooseDifferent',
                        message: 'Would you like to choose a different slug?',
                        default: true,
                    },
                ]);

                if (shouldChooseDifferent) {
                    console.log(
                        chalk.blue('\nℹ Please run the command again with a different slug.'),
                    );
                    return;
                } else {
                    console.log(chalk.blue('\nℹ Directory creation cancelled.'));
                    return;
                }
            }

            spinner.succeed('Directory slug is available');

            // Create directory
            const createSpinner = ora('Creating directory...').start();

            const finalDirectoryData = {
                slug: directoryData.slug,
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
}
