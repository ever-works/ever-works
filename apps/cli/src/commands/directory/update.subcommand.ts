import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository } from '@packages/agent/database';
import { AgentService } from '@packages/agent/http';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';

@SubCommand({
    name: 'update',
    description: 'Update a directory and its GitHub repository',
})
export class UpdateSubCommand extends CommandRunner {
    private readonly logger = new Logger(UpdateSubCommand.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly agentService: AgentService,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n🔄 Update Directory\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Select directory
            const selection = await this.directoryPrompt.promptDirectorySelection(this.directoryRepository);
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

            // Prompt for update options
            const updateOptions = await this.promptUpdateOptions();

            // Show confirmation
            console.log(chalk.cyan('\n--- Update Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('Generation Method:'), chalk.white(updateOptions.generation_method));
            console.log(chalk.gray('Update with PR:'), chalk.white(updateOptions.update_with_pull_request ? 'Yes' : 'No'));

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
            const spinner = ora('Updating directory...').start();

            try {
                // Call the agent service method directly
                const result = await this.agentService.updateItemsGenerator(directory.slug, updateOptions);

                spinner.succeed('Directory update initiated successfully');
                console.log(chalk.green('\n✓ Update initiated successfully!'));
                console.log(chalk.gray('Status:'), chalk.white(result.status));
                console.log(chalk.gray('Message:'), chalk.white(result.message));
                console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
                console.log(chalk.gray('Generation Method:'), chalk.white(updateOptions.generation_method));
                console.log(chalk.gray('Update with PR:'), chalk.white(updateOptions.update_with_pull_request ? 'Yes' : 'No'));

                if (result.status === 'pending') {
                    console.log(chalk.cyan('\n--- Processing ---'));
                    console.log(chalk.gray('The update is being processed in the background.'));
                    console.log(chalk.gray('Check the logs or data directory for updates.'));
                }

            } catch (error) {
                spinner.fail('Failed to update directory');
                throw error;
            }

        } catch (error) {
            this.logger.error('Failed to update directory:', error);
            console.log(chalk.red('\n✗ Failed to update directory:'), error.message);
        }
    }

    private async promptUpdateOptions() {
        console.log(chalk.cyan('\n--- Update Options ---'));

        const { generation_method } = await inquirer.prompt([
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
        ]);

        const { update_with_pull_request } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'update_with_pull_request',
                message: 'Create pull request for updates?',
                default: true,
            },
        ]);

        return {
            generation_method,
            update_with_pull_request,
        };
    }
}
