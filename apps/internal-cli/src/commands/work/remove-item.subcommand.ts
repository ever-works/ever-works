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
    name: 'remove-item',
    description: 'Remove an item from a work',
})
export class RemoveItemSubCommand extends CommandRunner {
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
            console.log(chalk.cyan.bold('\nRemove Item from Work\n'));

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

            // Prompt for removal details
            const removalData = await this.promptRemovalDetails();

            // Show confirmation
            console.log(chalk.cyan('\n--- Item Removal Summary ---'));
            console.log(chalk.gray('Work:'), chalk.white(work.slug));
            console.log(chalk.gray('Item Slug:'), chalk.white(removalData.item_slug));
            if (removalData.reason) {
                console.log(chalk.gray('Reason:'), chalk.white(removalData.reason));
            }

            console.log(
                chalk.red(
                    '\n⚠ WARNING: This action will permanently remove the item from the work.',
                ),
            );

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Are you sure you want to remove this item?',
                    default: false,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Removal cancelled.'));
                return;
            }

            // Remove item
            const spinner = ora('Removing item...').start();

            try {
                const user = await this.userRepository.createOrGetLocalUser();

                // Call the agent service method directly
                const result = await this.workGenerationService.removeItem(
                    work.id,
                    removalData,
                    user,
                );

                if (result.status === 'error') {
                    spinner.fail('Failed to remove item');
                    console.log(chalk.red('\n✗ Failed to remove item:'));
                    return;
                }

                spinner.stop();

                console.log(chalk.green('\n✓ Item removed successfully!'));
                console.log(chalk.gray('Status:'), chalk.white(result.status));

                if (result.message) {
                    console.log(chalk.gray('Message:'), chalk.white(result.message));
                }

                if (result.pr_url) {
                    console.log(chalk.cyan('\n--- Pull Request Created ---'));
                    console.log(chalk.gray('PR URL:'), chalk.blue(result.pr_url));
                    console.log(chalk.gray('PR Title:'), chalk.white(result.pr_title));
                    console.log(chalk.gray('Branch:'), chalk.white(result.pr_branch_name));
                }
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to remove item');
            process.exit(1);
        }
    }

    private async promptRemovalDetails() {
        console.log(chalk.cyan('\n--- Item Removal Details ---'));

        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'item_slug',
                message: 'Item slug to remove:',
                validate: (input) => {
                    if (!input.trim()) return 'Item slug is required';
                    if (!/^[a-z0-9-]+$/.test(input)) {
                        return 'Item slug must contain only lowercase letters, numbers, and hyphens';
                    }
                    return true;
                },
            },
            {
                type: 'input',
                name: 'reason',
                message: 'Reason for removal (optional):',
                validate: (input) => {
                    if (input && input.length > 500) {
                        return 'Reason must be less than 500 characters';
                    }
                    return true;
                },
            },
        ]);

        return {
            item_slug: answers.item_slug,
            reason: answers.reason.trim() || undefined,
        };
    }
}
