import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, CreateItemsGeneratorDto } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';

// Use enums for better type safety
enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    FORK = 'fork',
    CREATE_USING_TEMPLATE = 'create-using-template',
}

export const generateCommand = new Command('generate')
    .description('Generate data and create a GitHub repository for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🚀 Generate Directory Content\n'));

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

            // Collect generation parameters
            console.log(chalk.cyan('\n📝 Generation Configuration'));
            
            const basicAnswers = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'name',
                    message: 'Generation name:',
                    default: `${directory.name} Content Generation`,
                    validate: (input) => input.trim().length > 0 || 'Generation name is required'
                },
                {
                    type: 'input',
                    name: 'prompt',
                    message: 'Generation prompt (describe what you want to generate):',
                    validate: (input) => input.trim().length > 0 || 'Generation prompt is required'
                }
            ]);

            // Ask for advanced configuration
            const advancedConfig = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'configureAdvanced',
                    message: 'Configure advanced options?',
                    default: false
                }
            ]);

            let createItemsGeneratorDto: CreateItemsGeneratorDto = {
                slug: directory.slug,
                name: basicAnswers.name,
                prompt: basicAnswers.prompt
            };

            if (advancedConfig.configureAdvanced) {
                const advancedAnswers = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'generation_method',
                        message: 'Generation method:',
                        choices: [
                            { name: 'Create/Update (recommended)', value: GenerationMethod.CREATE_UPDATE },
                            { name: 'Recreate (replace existing)', value: GenerationMethod.RECREATE }
                        ],
                        default: GenerationMethod.CREATE_UPDATE
                    },
                    {
                        type: 'list',
                        name: 'website_repository_creation_method',
                        message: 'Website repository creation method:',
                        choices: [
                            { name: 'Duplicate', value: WebsiteRepositoryCreationMethod.DUPLICATE },
                            { name: 'Fork', value: WebsiteRepositoryCreationMethod.FORK },
                            { name: 'Create using template', value: WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE }
                        ],
                        default: WebsiteRepositoryCreationMethod.DUPLICATE
                    },
                    {
                        type: 'input',
                        name: 'repository_description',
                        message: 'Repository description (optional):'
                    },
                    {
                        type: 'input',
                        name: 'initial_categories',
                        message: 'Initial categories (comma-separated, optional):',
                        filter: (input) => input ? input.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined
                    },
                    {
                        type: 'input',
                        name: 'target_keywords',
                        message: 'Target keywords (comma-separated, optional):',
                        filter: (input) => input ? input.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined
                    },
                    {
                        type: 'input',
                        name: 'source_urls',
                        message: 'Source URLs (comma-separated, optional):',
                        filter: (input) => input ? input.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined
                    }
                ]);

                // Company information
                const companyConfig = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'addCompany',
                        message: 'Add company information?',
                        default: false
                    }
                ]);

                if (companyConfig.addCompany) {
                    const companyAnswers = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'name',
                            message: 'Company name:',
                            validate: (input) => input.trim().length > 0 || 'Company name is required'
                        },
                        {
                            type: 'input',
                            name: 'website',
                            message: 'Company website:',
                            validate: (input) => {
                                try {
                                    new URL(input);
                                    return true;
                                } catch {
                                    return 'Please enter a valid URL';
                                }
                            }
                        }
                    ]);

                    createItemsGeneratorDto.company = companyAnswers;
                }

                // Merge advanced configuration
                Object.assign(createItemsGeneratorDto, advancedAnswers);
            }

            // Show summary and confirm
            console.log(chalk.cyan('\n--- Generation Summary ---'));
            console.log(chalk.gray('Directory:'), chalk.white(directory.slug));
            console.log(chalk.gray('Name:'), chalk.white(createItemsGeneratorDto.name));
            console.log(chalk.gray('Prompt:'), chalk.white(createItemsGeneratorDto.prompt));
            if (createItemsGeneratorDto.company) {
                console.log(chalk.gray('Company:'), chalk.white(createItemsGeneratorDto.company.name));
            }

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with generation?',
                    default: true
                }
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Generation cancelled.'));
                return;
            }

            // Start generation
            const spinner = ora('Starting generation process...').start();

            try {
                const response = await apiService.generateContent(createItemsGeneratorDto);

                spinner.succeed('Generation started successfully');

                console.log(chalk.green('\n✓ Generation process started!'));
                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }
                
                console.log(chalk.cyan('\nNext Steps:'));
                console.log(chalk.gray('  • Monitor the generation progress in your logs'));
                console.log(chalk.gray('  • Check your GitHub repositories for updates'));
                console.log(chalk.gray('  • Use other directory commands once generation is complete'));

            } catch (error) {
                spinner.fail('Generation failed');
                throw error;
            }

        } catch (error) {
            console.error(chalk.red('\n✗ Failed to start generation:'), error.response?.data?.message || error.message);

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 404) {
                console.log(chalk.yellow('\n⚠ Directory not found. Please check the slug and try again.'));
            }

            process.exit(1);
        }
    });
