import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { WorkRepository, UserRepository } from '@ever-works/agent/database';
import { WorkGenerationService } from '@ever-works/agent/services';
import { WorkPromptService } from './work-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'update',
    description: 'Update a work and its repository',
})
export class UpdateSubCommand extends CommandRunner {
    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workPrompt: WorkPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly workGenerationService: WorkGenerationService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nUpdate Work\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Select work
            const selection = await this.workPrompt.promptWorkSelection(
                this.workRepository,
            );
            if (selection.cancelled || !selection.work) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const work = selection.work;
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected work: ${this.workPrompt.formatSelectedWork(work, role, isShared)}`,
                ),
            );

            // Prompt for update options
            const updateOptions = await this.promptUpdateOptions();

            // Show confirmation
            console.log(chalk.cyan('\n--- Update Summary ---'));
            console.log(chalk.gray('Work:'), chalk.white(work.slug));
            console.log(
                chalk.gray('Generation Method:'),
                chalk.white(updateOptions.generation_method),
            );
            console.log(
                chalk.gray('Update with PR:'),
                chalk.white(updateOptions.update_with_pull_request ? 'Yes' : 'No'),
            );

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with the update?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Update cancelled.'));
                return;
            }

            // Perform update
            const spinner = ora('Updating work...').start();

            try {
                const user = await this.userRepository.createOrGetLocalUser();

                // Call the agent service method directly
                const result = await this.workGenerationService.updateItemsGenerator({
                    workId: work.id,
                    updateDto: updateOptions,
                    user,
                    awaitCompletion: true,
                });

                spinner.stop();

                if (result.status === 'error') {
                    console.log(chalk.red('\n✗ Failed to update work'));
                } else {
                    console.log(chalk.green('\n✓ Update initiated successfully!'));
                }

                console.log(chalk.gray('Status:'), chalk.white(result.status));
                console.log(chalk.gray('Work:'), chalk.white(work.slug));
                if (result.message) {
                    console.log(chalk.gray('Message:'), chalk.white(result.message));
                }

                console.log(
                    chalk.gray('Generation Method:'),
                    chalk.white(updateOptions.generation_method),
                );
                console.log(
                    chalk.gray('Update with PR:'),
                    chalk.white(updateOptions.update_with_pull_request ? 'Yes' : 'No'),
                );

                if (result.status === 'pending') {
                    console.log(chalk.cyan('\n--- Processing ---'));
                    console.log(chalk.gray('The update is being processed in the background.'));
                    console.log(chalk.gray('Check the logs or data work for updates.'));
                }
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to update work content');
            process.exit(1);
        }
    }

    private async promptUpdateOptions() {
        console.log(chalk.cyan('\n--- Update Options ---'));

        const answers = await inquirer.prompt([
            {
                type: 'list',
                name: 'generation_method',
                message: 'Select generation method:',
                choices: [
                    {
                        name: 'Create/Update - Add new items and update existing ones',
                        value: 'create-update',
                        short: 'create-update',
                    },
                    {
                        name: 'Recreate - Replace all existing items',
                        value: 'recreate',
                        short: 'recreate',
                    },
                ],
                default: 'create-update',
            },
            {
                type: 'confirm',
                name: 'update_with_pull_request',
                message: 'Create pull request for updates?',
                default: true,
            },
        ]);

        return {
            generation_method: answers.generation_method,
            update_with_pull_request: answers.update_with_pull_request,
        };
    }
}
