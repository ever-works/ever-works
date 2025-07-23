import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';

export const submitItemCommand = new Command('submit-item')
    .description('Submit an item to a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n📤 Submit Item\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

            // Select directory
            const selection = await directoryPrompt.promptDirectorySelection();
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

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
                    type: 'confirm',
                    name: 'featured',
                    message: 'Mark as featured?',
                    default: false,
                },
            ]);

            // Show summary and confirm
            console.log(chalk.cyan('\n--- Item Submission Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('URL:'), chalk.white(answers.source_url));
            if (answers.name) console.log(chalk.gray('Name:'), chalk.white(answers.name));
            if (answers.description)
                console.log(chalk.gray('Description:'), chalk.white(answers.description));
            if (answers.category)
                console.log(chalk.gray('Category:'), chalk.white(answers.category));

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Submit this item?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Item submission cancelled.'));
                return;
            }

            // Submit item
            const spinner = ora('Submitting item...').start();

            try {
                const submitDto = {
                    name: answers.name,
                    description: answers.description,
                    source_url: answers.source_url,
                    category: answers.category,
                    tags: answers.tags
                        ? answers.tags
                              .split(',')
                              .map((tag: string) => tag.trim())
                              .filter((tag: string) => tag.length > 0)
                        : undefined,
                    featured: answers.featured || false,
                };

                const response = await apiService.submitItem(directory.slug, submitDto);

                spinner.succeed('Item submitted successfully');

                console.log(chalk.green('\n✓ Item submitted successfully!'));
                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }

                if (response.item) {
                    console.log(chalk.cyan('\nItem Details:'));
                    console.log(chalk.gray('Name:'), chalk.white(response.item.name));
                    console.log(chalk.gray('Category:'), chalk.white(response.item.category));
                }
            } catch (error) {
                spinner.fail('Item submission failed');
                throw error;
            }
        } catch (error) {
            console.error(
                chalk.red('\n✗ Failed to submit item:'),
                error.response?.data?.message || error.message,
            );

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 404) {
                console.log(
                    chalk.yellow('\n⚠ Directory not found. Please check the slug and try again.'),
                );
            }

            process.exit(1);
        }
    });
