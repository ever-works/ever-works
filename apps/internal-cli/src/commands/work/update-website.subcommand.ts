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
    name: 'update-website',
    description: 'Update the website repository for a work',
})
export class UpdateWebsiteSubCommand extends CommandRunner {
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
            console.log(chalk.cyan.bold('\nUpdate Website Repository\n'));

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

            // Show information about what will happen
            console.log(chalk.cyan('\n--- Website Update Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Update the website repository from the template'));
            console.log(chalk.gray('  • Sync latest changes and improvements'));
            console.log(chalk.gray('  • Maintain your existing customizations'));
            console.log(chalk.gray('  • Push updates to the repository'));

            const websiteOwner = work.getRepoOwner('website');
            const websiteRepo = work.getWebsiteRepo();
            console.log(
                chalk.gray('\nTarget repository:'),
                chalk.white(`${websiteOwner}/${websiteRepo}`),
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
                const result = await this.workGenerationService.updateWebsiteRepository(
                    work.id,
                    user,
                );

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
                            chalk.cyan('work deploy') +
                            chalk.gray(' to deploy the website'),
                    );
                } else if (result.status === 'error' && result.message) {
                    console.log(chalk.red('\n--- Error Details ---'));
                    console.log(chalk.red(result.message));
                }
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to update website repository');
            process.exit(1);
        }
    }
}
