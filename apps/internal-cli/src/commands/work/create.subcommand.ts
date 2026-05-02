import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import { WorkRepository, UserRepository } from '@ever-works/agent/database';
import { GitFacadeService } from '@ever-works/agent/facades';
import { WorkPromptService } from './work-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';
import { WorkLifecycleService } from '@ever-works/agent/services';

@SubCommand({
    name: 'create',
    description: 'Create a new work',
})
export class CreateSubCommand extends CommandRunner {
    constructor(
        private readonly workLifecycleService: WorkLifecycleService,
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly workPrompt: WorkPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nCreate New Work\n'));

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

            // Collect work information
            const workData = await this.workPrompt.promptWorkCreation(ghOwner.login, orgs);

            if (workData.cancelled) {
                console.log(chalk.blue('\nℹ Work creation cancelled.'));
                process.exit(0);
            }

            // Create the work
            const creationSpinner = ora('Creating work...').start();

            try {
                await this.workLifecycleService.createWork(
                    {
                        slug: workData.slug,
                        name: workData.name,
                        description: workData.description,
                        gitProvider: providerId,
                        owner: workData.owner ?? undefined,
                        organization: !!workData.owner,
                    },
                    user,
                );

                creationSpinner.succeed(`Work "${workData.name}" created successfully!`);
                console.log(chalk.gray(`\nSlug: ${workData.slug}`));
                console.log(
                    chalk.gray(`Owner: ${workData.owner || `${ghOwner.login} (Personal)`}`),
                );
                console.log(
                    chalk.gray(`Organization: ${workData.owner ? 'Yes' : 'No (Personal)'}`),
                );
            } catch (error) {
                creationSpinner.fail('Failed to create work');
                throw error;
            }
        } catch (error) {
            handleCliError(error);
        }
    }
}
