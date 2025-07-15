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
    name: 'submit-item',
    description: 'Submit an item to a directory',
})
export class SubmitItemSubCommand extends CommandRunner {
    private readonly logger = new Logger(SubmitItemSubCommand.name);

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
            console.log(chalk.cyan.bold('\n📝 Submit Item to Directory\n'));

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

            // Prompt for item details
            const itemData = await this.promptItemDetails();

            // Show confirmation
            console.log(chalk.cyan('\n--- Item Submission Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('Item Name:'), chalk.white(itemData.name));
            console.log(chalk.gray('Source URL:'), chalk.white(itemData.source_url));
            console.log(chalk.gray('Category:'), chalk.white(itemData.category));
            if (itemData.tags && itemData.tags.length > 0) {
                console.log(chalk.gray('Tags:'), chalk.white(itemData.tags.join(', ')));
            }
            console.log(chalk.gray('Featured:'), chalk.white(itemData.featured ? 'Yes' : 'No'));
            console.log(chalk.gray('Pay and Publish Now:'), chalk.white(itemData.pay_and_publish_now ? 'Yes' : 'No'));

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Submit this item?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Submission cancelled.'));
                return;
            }

            // Submit item
            const spinner = ora('Submitting item...').start();

            try {
                // Call the agent service method directly
                const result = await this.agentService.submitItem(directory.slug, itemData);

                spinner.succeed('Item submitted successfully');

                console.log(chalk.green('\n✓ Item submitted successfully!'));
                console.log(chalk.gray('Status:'), chalk.white(result.status));
                console.log(chalk.gray('Message:'), chalk.white(result.message));

                if (result.pr_url) {
                    console.log(chalk.cyan('\n--- Pull Request Created ---'));
                    console.log(chalk.gray('PR URL:'), chalk.blue(result.pr_url));
                    console.log(chalk.gray('PR Title:'), chalk.white(result.pr_title));
                    console.log(chalk.gray('Branch:'), chalk.white(result.pr_branch_name));
                }

            } catch (error) {
                spinner.fail('Failed to submit item');
                throw error;
            }

        } catch (error) {
            this.logger.error('Failed to submit item:', error);
            console.log(chalk.red('\n✗ Failed to submit item:'), error.message);
        }
    }

    private async promptItemDetails() {
        console.log(chalk.cyan('\n--- Item Details ---'));

        // Required fields
        const { name } = await inquirer.prompt([
            {
                type: 'input',
                name: 'name',
                message: 'Item name:',
                validate: (input) => {
                    if (!input.trim()) return 'Item name is required';
                    if (input.length > 100) return 'Item name must be less than 100 characters';
                    return true;
                },
            },
        ]);

        const { description } = await inquirer.prompt([
            {
                type: 'input',
                name: 'description',
                message: 'Item description:',
                validate: (input) => {
                    if (!input.trim()) return 'Description is required';
                    if (input.length > 500) return 'Description must be less than 500 characters';
                    return true;
                },
            },
        ]);

        const { source_url } = await inquirer.prompt([
            {
                type: 'input',
                name: 'source_url',
                message: 'Source URL:',
                validate: (input) => {
                    if (!input.trim()) return 'Source URL is required';
                    try {
                        new URL(input);
                        return true;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                },
            },
        ]);

        const { category } = await inquirer.prompt([
            {
                type: 'input',
                name: 'category',
                message: 'Category:',
                validate: (input) => {
                    if (!input.trim()) return 'Category is required';
                    return true;
                },
            },
        ]);

        // Optional fields
        const { tags } = await inquirer.prompt([
            {
                type: 'input',
                name: 'tags',
                message: 'Tags (comma-separated, optional):',
                filter: (input: string) => {
                    if (!input.trim()) return [];
                    return input.split(',').map((tag: string) => tag.trim()).filter((tag: string) => tag.length > 0);
                },
            },
        ]);

        const { featured } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'featured',
                message: 'Mark as featured?',
                default: false,
            },
        ]);

        const { pay_and_publish_now } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'pay_and_publish_now',
                message: 'Pay and publish now?',
                default: false,
            },
        ]);

        const { slug } = await inquirer.prompt([
            {
                type: 'input',
                name: 'slug',
                message: 'Custom slug (optional, will be auto-generated if empty):',
                validate: (input) => {
                    if (input && !/^[a-z0-9-]+$/.test(input)) {
                        return 'Slug must contain only lowercase letters, numbers, and hyphens';
                    }
                    return true;
                },
            },
        ]);

        return {
            name,
            description,
            source_url,
            category,
            tags: tags.length > 0 ? tags : undefined,
            featured,
            pay_and_publish_now,
            slug: slug.trim() || undefined,
        };
    }
}
