import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { WorkRepository, UserRepository } from '@ever-works/agent/database';
import { WorkLifecycleService } from '@ever-works/agent/services';
import { WorkPromptService } from './work-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'delete',
    description: 'Delete a work and its repositories',
})
export class DeleteSubCommand extends CommandRunner {
    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workPrompt: WorkPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly workLifecycleService: WorkLifecycleService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nDelete Work\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Select work
            const selection = await this.workPrompt.promptWorkSelection(this.workRepository);
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

            // Prompt for deletion options
            const deleteOptions = await this.promptDeleteOptions();

            // Show what will be deleted
            console.log(chalk.cyan('\n--- Deletion Summary ---'));
            console.log(chalk.gray('Work:'), chalk.white(work.slug));
            console.log(chalk.gray('Owner:'), chalk.white(work.getRepoOwner()));

            const repositoriesToDelete: string[] = [];
            if (deleteOptions.delete_data_repository) {
                repositoriesToDelete.push(`${work.getRepoOwner()}/${work.getDataRepo()}`);
            }
            if (deleteOptions.delete_markdown_repository) {
                repositoriesToDelete.push(`${work.getRepoOwner('work')}/${work.getMainRepo()}`);
            }
            if (deleteOptions.delete_website_repository) {
                repositoriesToDelete.push(
                    `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`,
                );
            }

            if (repositoriesToDelete.length > 0) {
                console.log(chalk.gray('\nRepositories to delete:'));
                repositoriesToDelete.forEach((repo) => {
                    console.log(chalk.red(`  • ${repo}`));
                });
            }

            if (deleteOptions.reason) {
                console.log(chalk.gray('\nReason:'), chalk.white(deleteOptions.reason));
            }

            console.log(chalk.red('\n⚠ WARNING: This action is IRREVERSIBLE!'));
            console.log(
                chalk.red(
                    'All data, repositories, and configurations will be permanently deleted.',
                ),
            );

            // Double confirmation
            const firstConfirm = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Are you absolutely sure you want to delete this work?',
                    default: false,
                },
            ]);

            if (!firstConfirm.proceed) {
                console.log(chalk.yellow('\n⚠ Deletion cancelled.'));
                return;
            }

            // Type confirmation
            const typeConfirm = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'confirmation',
                    message: `Type "${work.slug}" to confirm deletion:`,
                    validate: (input) => {
                        if (input !== work.slug) {
                            return `You must type "${work.slug}" exactly to confirm`;
                        }
                        return true;
                    },
                },
            ]);

            if (typeConfirm.confirmation !== work.slug) {
                console.log(chalk.yellow('\n⚠ Deletion cancelled.'));
                return;
            }

            // Perform deletion
            const spinner = ora('Deleting work and repositories...').start();

            try {
                const user = await this.userRepository.createOrGetLocalUser();

                // Call the agent service method directly
                const result = await this.workLifecycleService.deleteWork(
                    work.id,
                    deleteOptions,
                    user,
                );

                spinner.stop();

                if (result.status === 'error') {
                    console.log(chalk.red('\n✗ Work deletion failed'));
                } else {
                    console.log(chalk.green('\n✓ Work deleted successfully!'));
                }

                console.log(chalk.gray('Status:'), chalk.white(result.status));
                if (result.message) {
                    console.log(chalk.gray('Message:'), chalk.white(result.message));
                }

                if (result.deleted_repositories && result.deleted_repositories.length > 0) {
                    console.log(chalk.gray('\nDeleted repositories:'));
                    result.deleted_repositories.forEach((repo) => {
                        console.log(chalk.gray(`  • ${repo}`));
                    });
                }
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to delete work');
            process.exit(1);
        }
    }

    private async promptDeleteOptions() {
        console.log(chalk.cyan('\n--- Deletion Options ---'));

        const answers = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'delete_data_repository',
                message: 'Delete data repository?',
                default: true,
            },
            {
                type: 'confirm',
                name: 'delete_markdown_repository',
                message: 'Delete markdown repository?',
                default: true,
            },
            {
                type: 'confirm',
                name: 'delete_website_repository',
                message: 'Delete website repository?',
                default: true,
            },
            {
                type: 'input',
                name: 'reason',
                message: 'Reason for deletion (optional):',
                validate: (input) => {
                    if (input && input.length > 500) {
                        return 'Reason must be less than 500 characters';
                    }
                    return true;
                },
            },
        ]);

        return {
            delete_data_repository: answers.delete_data_repository,
            delete_markdown_repository: answers.delete_markdown_repository,
            delete_website_repository: answers.delete_website_repository,
            reason: answers.reason.trim() || undefined,
        };
    }
}
