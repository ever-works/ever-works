import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { AgentService } from '@packages/agent/services';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';

@SubCommand({
    name: 'update-website',
    description: 'Update the website repository for a directory',
})
export class UpdateWebsiteSubCommand extends CommandRunner {
    private readonly logger = new Logger(UpdateWebsiteSubCommand.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly agentService: AgentService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nUpdate Website Repository\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Select directory
            const selection = await this.directoryPrompt.promptDirectorySelection(
                this.directoryRepository,
            );
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

            // Show information about what will happen
            console.log(chalk.cyan('\n--- Website Update Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Update the website repository from the template'));
            console.log(chalk.gray('  • Sync latest changes and improvements'));
            console.log(chalk.gray('  • Maintain your existing customizations'));
            console.log(chalk.gray('  • Push updates to the repository'));

            const websiteRepo = `${directory.slug}-website`;
            console.log(
                chalk.gray('\nTarget repository:'),
                chalk.white(`${directory.getRepoOwner()}/${websiteRepo}`),
            );

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with website repository update?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Website update cancelled.'));
                return;
            }

            // Update website repository
            const spinner = ora('Updating website repository...').start();

            try {
                const user = await this.userRepository.createOrGetLocalUser();

                // Call the agent service method directly
                const result = await this.agentService.updateWebsiteRepository(directory.id, user);

                spinner.stop();

                if (result.status === 'error') {
                    console.log(chalk.red('\n✗ Failed to update website repository'));
                } else {
                    console.log(chalk.green('\n✓ Website repository updated successfully!'));
                }

                console.log(chalk.gray('Status:'), chalk.white(result.status));
                console.log(chalk.gray('Repository:'), chalk.white(result.repository));
                console.log(chalk.gray('Message:'), chalk.white(result.message));

                if (result.method_used) {
                    console.log(chalk.gray('Update Method:'), chalk.white(result.method_used));
                }

                if (result.status === 'success') {
                    console.log(chalk.cyan('\n--- Next Steps ---'));
                    console.log(chalk.gray('  • Check your website repository for updates'));
                    console.log(chalk.gray('  • Review the changes that were applied'));
                    console.log(chalk.gray('  • Consider deploying the updated website'));
                    console.log(
                        chalk.gray('  • Use ') +
                            chalk.cyan('directory deploy') +
                            chalk.gray(' to deploy the website'),
                    );
                } else if (result.status === 'error' && result.message) {
                    console.log(chalk.red('\n--- Error Details ---'));
                    console.log(chalk.red(result.message));
                }
            } catch (error) {
                spinner.fail('Failed to update website repository');
                throw error;
            }
        } catch (error) {
            this.logger.error('Failed to update website repository:', error);
            console.log(chalk.red('\n✗ Failed to update website repository:'), error.message);
        }
    }
}
