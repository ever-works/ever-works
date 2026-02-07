import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import { DirectoryRepository, UserRepository } from '@ever-works/agent/database';
import { GitFacadeService } from '@ever-works/agent/facades';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';
import { DirectoryLifecycleService } from '@ever-works/agent/services';

@SubCommand({
    name: 'create',
    description: 'Create a new directory',
})
export class CreateSubCommand extends CommandRunner {
    constructor(
        private readonly directoryLifecycleService: DirectoryLifecycleService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly gitFacade: GitFacadeService,
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
            const providerId = process.env.GIT_PROVIDER || 'github';
            const token = process.env.GIT_TOKEN;
            if (!token) {
                throw new Error('Git provider token is required. Run "config setup" to configure.');
            }
            const options = { userId: user.id, providerId, token };

            const ghOwner = await this.gitFacade.getUser(options);

            const orgs = await this.gitFacade
                .getOrganizations(options)
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

            if (directoryData.cancelled) {
                console.log(chalk.blue('\nℹ Directory creation cancelled.'));
                process.exit(0);
            }

            // Create the directory
            const creationSpinner = ora('Creating directory...').start();

            try {
                await this.directoryLifecycleService.createDirectory(
                    {
                        slug: directoryData.slug,
                        name: directoryData.name,
                        description: directoryData.description,
                        gitProvider: providerId,
                        owner: directoryData.owner ?? undefined,
                        organization: !!directoryData.owner,
                    },
                    user,
                );

                creationSpinner.succeed(`Directory "${directoryData.name}" created successfully!`);
                console.log(chalk.gray(`\nSlug: ${directoryData.slug}`));
                console.log(
                    chalk.gray(`Owner: ${directoryData.owner || `${ghOwner.login} (Personal)`}`),
                );
                console.log(
                    chalk.gray(`Organization: ${directoryData.owner ? 'Yes' : 'No (Personal)'}`),
                );
            } catch (error) {
                creationSpinner.fail('Failed to create directory');
                throw error;
            }
        } catch (error) {
            handleCliError(error);
        }
    }
}
