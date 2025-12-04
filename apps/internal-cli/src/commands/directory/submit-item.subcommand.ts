import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { DirectoryGenerationService } from '@packages/agent/services';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'submit-item',
    description: 'Submit an item to a directory',
})
export class SubmitItemSubCommand extends CommandRunner {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly directoryGenerationService: DirectoryGenerationService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nSubmit Item to Directory\n'));

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

            // Prompt for item details
            const itemData = await this.promptItemDetails();

            // Show confirmation
            console.log(chalk.cyan('\n--- Item Submission Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('Name:'), chalk.white(itemData.name));
            console.log(chalk.gray('Source URL:'), chalk.white(itemData.source_url));
            console.log(chalk.gray('Category:'), chalk.white(itemData.category));
            if (itemData.tags?.length) {
                console.log(chalk.gray('Tags:'), chalk.white(itemData.tags.join(', ')));
            }
            if (itemData.brand) {
                console.log(chalk.gray('Brand:'), chalk.white(itemData.brand));
            }
            if (itemData.brand_logo_url) {
                console.log(chalk.gray('Brand Logo:'), chalk.white(itemData.brand_logo_url));
            }
            if (itemData.images?.length) {
                console.log(chalk.gray('Images:'), chalk.white(itemData.images.join(', ')));
            }
            console.log(chalk.gray('Featured:'), chalk.white(itemData.featured ? 'Yes' : 'No'));
            console.log(
                chalk.gray('Push to main:'),
                chalk.white(itemData.pay_and_publish_now ? 'Yes' : 'No'),
            );

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
                const user = await this.userRepository.createOrGetLocalUser();

                // Call the agent service method directly
                const result = await this.directoryGenerationService.submitItem(
                    directory.id,
                    itemData,
                    user,
                );

                spinner.stop();

                if (result.status === 'error') {
                    console.log(chalk.red('\n✗ Item submission failed'));
                } else {
                    console.log(chalk.green('\n✓ Item submitted successfully!'));
                }

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
            handleCliError(error, 'Failed to submit item');
            process.exit(1);
        }
    }

    private async promptItemDetails() {
        console.log(chalk.cyan('\n--- Item Details ---'));

        const answers = await inquirer.prompt([
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
            {
                type: 'input',
                name: 'category',
                message: 'Category:',
                validate: (input) => (input.trim() ? true : 'Category is required'),
            },
            {
                type: 'input',
                name: 'tags',
                message: 'Tags (comma-separated, optional):',
            },
            {
                type: 'input',
                name: 'brand',
                message: 'Brand (optional):',
            },
            {
                type: 'input',
                name: 'brand_logo_url',
                message: 'Brand logo URL (optional):',
                validate: (input) => {
                    if (!input.trim()) return true;
                    try {
                        new URL(input);
                        return true;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                },
            },
            {
                type: 'input',
                name: 'images',
                message: 'Image URLs (comma-separated, optional):',
            },
            {
                type: 'confirm',
                name: 'featured',
                message: 'Mark as featured?',
                default: false,
            },
            {
                type: 'confirm',
                name: 'pay_and_publish_now',
                message: 'Push to main without PR?',
                default: true,
            },
            {
                type: 'input',
                name: 'slug',
                message: 'Custom slug (optional):',
                validate: (input) => {
                    if (input && !/^[a-z0-9-]+$/.test(input)) {
                        return 'Slug must contain only lowercase letters, numbers, and hyphens';
                    }
                    return true;
                },
            },
        ]);

        const parseCommaSeparated = (input: string): string[] | undefined => {
            if (!input?.trim()) return undefined;
            const items = input
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            return items.length > 0 ? items : undefined;
        };

        return {
            name: answers.name,
            description: answers.description,
            source_url: answers.source_url,
            category: answers.category,
            tags: parseCommaSeparated(answers.tags),
            brand: answers.brand?.trim() || undefined,
            brand_logo_url: answers.brand_logo_url?.trim() || undefined,
            images: parseCommaSeparated(answers.images),
            featured: answers.featured,
            pay_and_publish_now: answers.pay_and_publish_now,
            slug: answers.slug?.trim() || undefined,
        };
    }
}
