import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { WorkPromptService, canEdit } from './work-prompt.service';
import { handleCliError } from '../../utils/error';

export const submitItemCommand = new Command('submit-item')
    .description('Submit an item to a work')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nSubmit Item to Work\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const workPrompt = new WorkPromptService();

            // Select work
            const selection = await workPrompt.promptWorkSelection();
            if (selection.cancelled || !selection.work) {
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            const work = selection.work;
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected work: ${workPrompt.formatSelectedWork(work, role, isShared)}`,
                ),
            );

            if (!canEdit(role)) {
                console.log(chalk.yellow('\n⚠ You do not have permission to perform this action.'));
                console.log(chalk.gray(`  Your role: ${role}. Required: editor or higher.`));
                return;
            }

            // Collect item information
            const answers = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'source_url',
                    message: 'Item URL:',
                    validate: (input) => {
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
                    name: 'name',
                    message: 'Item name:',
                    validate: (input) => input.trim().length > 0 || 'Item name is required',
                },
                {
                    type: 'input',
                    name: 'description',
                    message: 'Item description:',
                    validate: (input) => input.trim().length > 0 || 'Item description is required',
                },
                {
                    type: 'input',
                    name: 'category',
                    message: 'Item category:',
                    validate: (input) => input.trim().length > 0 || 'Item category is required',
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
            ]);

            // Show summary and confirm
            console.log('');
            console.log(chalk.gray('Work:'), chalk.white(work.slug));
            console.log(chalk.gray('URL:'), chalk.white(answers.source_url));
            console.log(chalk.gray('Name:'), chalk.white(answers.name));
            console.log(chalk.gray('Description:'), chalk.white(answers.description));
            console.log(chalk.gray('Category:'), chalk.white(answers.category));
            if (answers.tags) console.log(chalk.gray('Tags:'), chalk.white(answers.tags));
            if (answers.brand) console.log(chalk.gray('Brand:'), chalk.white(answers.brand));
            if (answers.brand_logo_url)
                console.log(chalk.gray('Brand Logo:'), chalk.white(answers.brand_logo_url));
            if (answers.images) console.log(chalk.gray('Images:'), chalk.white(answers.images));
            console.log(chalk.gray('Featured:'), chalk.white(answers.featured ? 'Yes' : 'No'));

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Submit this item?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            // Submit item
            const spinner = ora('Submitting item...').start();

            try {
                const parseCommaSeparated = (input: string | undefined): string[] | undefined => {
                    if (!input?.trim()) return undefined;
                    const items = input
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    return items.length > 0 ? items : undefined;
                };

                const submitDto = {
                    name: answers.name,
                    description: answers.description,
                    source_url: answers.source_url,
                    category: answers.category,
                    tags: parseCommaSeparated(answers.tags),
                    brand: answers.brand?.trim() || undefined,
                    brand_logo_url: answers.brand_logo_url?.trim() || undefined,
                    images: parseCommaSeparated(answers.images),
                    featured: answers.featured || false,
                    pay_and_publish_now: true,
                };

                const response = await apiService.submitItem(work.id, submitDto);

                if (response.status === 'error') {
                    spinner.fail('Item submission failed');
                } else {
                    spinner.succeed('Item submitted successfully!');
                }

                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }

                if (response.item_name) {
                    console.log(chalk.cyan('\nItem Details:'));
                    console.log(chalk.gray('Slug:'), chalk.white(response.slug));
                    console.log(chalk.gray('Name:'), chalk.white(response.item_name));
                }
            } catch (error) {
                spinner.fail('Item submission failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
