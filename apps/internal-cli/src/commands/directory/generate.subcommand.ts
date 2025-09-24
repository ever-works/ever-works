import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { AgentService } from '@packages/agent/services';
import {
    CreateItemsGeneratorDto,
    CompanyDto,
    ConfigDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@packages/agent/items-generator';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';
import { Directory, GenerateStatusType, User } from '@packages/agent/entities';
import { getStepProgress, getStepText, ItemsGeneratorSteps } from '@packages/cli-shared';

@SubCommand({
    name: 'generate',
    description: 'Generate data and create a GitHub repository for a directory',
})
export class GenerateSubCommand extends CommandRunner {
    private readonly logger = new Logger(GenerateSubCommand.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly agentService: AgentService,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nGenerate Directory Content\n'));
            console.log(
                chalk.gray(
                    'This process may take a while. Please be patient and do not interrupt.',
                ),
            );

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Select directory
            const { directory, cancelled } = await this.directoryPrompt.promptDirectorySelection(
                this.directoryRepository,
            );

            if (cancelled || !directory) {
                console.log(chalk.blue('\nℹ Generation cancelled.'));
                return;
            }

            console.log(
                chalk.green(`\n✓ Selected directory: ${directory.name} (${directory.slug})`),
            );

            if (directory.generateStatus?.status === 'generating') {
                console.log(chalk.yellow('\n⚠ Generation already in progress.'));
                if (directory.generateStatus.step) {
                    console.log(
                        chalk.gray('Current step:'),
                        chalk.white(directory.generateStatus.step),
                    );
                }
                console.log(chalk.gray('Please wait for the current generation to complete.'));
                return;
            }

            // Collect required fields
            const requiredData = await this.promptRequiredFields();

            // Ask if user wants to configure advanced options
            const wantsAdvanced = await this.promptConfirm(
                'Do you want to configure advanced options?',
                false,
            );

            let advancedData = {};
            if (wantsAdvanced) {
                advancedData = await this.promptAdvancedOptions();
            }

            // Build the CreateItemsGeneratorDto
            const createDto: CreateItemsGeneratorDto = {
                name: requiredData.name,
                prompt: requiredData.prompt,
                config: new ConfigDto(), // Default config
                ...advancedData,
            };

            // Display summary
            this.displayGenerationSummary(createDto);

            const confirmGeneration = await this.promptConfirm(
                'Do you want to proceed with generation?',
                true,
            );

            if (!confirmGeneration) {
                console.log(chalk.blue('\nℹ Generation cancelled.'));
                return;
            }

            // Start generation
            const spinner = ora('Starting generation process...').start();

            try {
                const user = await this.userRepository.createOrGetLocalUser();

                const generatorPromise = this.agentService.generateItems(
                    directory.id,
                    createDto,
                    user,
                    true,
                );
                const checkStatus = this.generationStatus(spinner, user, directory);

                const [result] = await Promise.all([generatorPromise, checkStatus()]);

                spinner.stop();

                if (result.status === 'error') {
                    console.log(chalk.red('\n✗ Generation failed'));
                    console.log(chalk.gray(`  Status: ${result.status}`));
                    console.log(chalk.gray(`  Directory: ${result.slug}`));
                    console.log(chalk.gray(`  Message: ${result.message}`));
                } else {
                    console.log(chalk.green('\n✓ Generation process finished!'));
                    console.log(chalk.gray('\nGeneration Details:'));
                    console.log(chalk.gray(`  Status: ${result.status}`));
                    console.log(chalk.gray(`  Directory: ${result.slug}`));

                    if (result.message) {
                        console.log(chalk.gray(`  Message: ${result.message}`));
                    }

                    console.log(
                        chalk.gray('  • Use ') +
                            chalk.cyan('directory list') +
                            chalk.gray(' to see your directories'),
                    );
                }
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to generate directory content');
            process.exit(1);
        }
    }

    private generationStatus(spinner: ora.Ora, user: User, directory: Directory) {
        // Configuration
        const POLL_INTERVAL = 5000;
        const MAX_POLL_TIME = 30 * 60 * 1000; // 30 minutes max
        const startTime = Date.now();

        const checkStatus = async () => {
            try {
                // Check if we've exceeded max polling time
                if (Date.now() - startTime > MAX_POLL_TIME) {
                    spinner.warn('\n⚠ Status check timed out after 30 minutes');
                    spinner.stop();
                    return;
                }

                const { directory: freshDirectory } = await this.agentService.getDirectory(
                    directory.id,
                    user,
                );

                if (freshDirectory.generateStatus?.status === GenerateStatusType.GENERATED) {
                    spinner.succeed('\n✓ Generation process finished!');
                    spinner.stop();

                    // Show additional info if available
                    console.log(chalk.cyan('\n--- Generation Complete ---'));
                    console.log(chalk.gray('  • Directory is ready for use'));
                } else if (freshDirectory.generateStatus?.status === GenerateStatusType.ERROR) {
                    spinner.fail('\n✗ Generation failed');

                    if (freshDirectory.generateStatus?.error) {
                        console.log(chalk.red(`Error: ${freshDirectory.generateStatus.error}`));
                    }
                    spinner.stop();
                } else {
                    // Update spinner text with current step
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const timeStr = `[${Math.floor(elapsed / 60)}m ${elapsed % 60}s]`;

                    if (freshDirectory.generateStatus?.step) {
                        const step = freshDirectory.generateStatus.step as ItemsGeneratorSteps;
                        const stepText = getStepText(step);
                        const progress = getStepProgress(step);

                        spinner.text = `Generating ${timeStr}: ${stepText} - ${progress}%`;
                    } else {
                        spinner.text = `Generating ${timeStr}...`;
                    }

                    // Poll again after interval
                    setTimeout(checkStatus, POLL_INTERVAL);
                }
            } catch (error) {
                spinner.fail('Failed to fetch directory status');
                console.error(chalk.red('Error details:'), error);
                spinner.stop();
            }
        };

        return checkStatus;
    }

    private async promptRequiredFields(): Promise<{
        name: string;
        prompt: string;
    }> {
        console.log(chalk.cyan('\n--- Required Fields ---'));

        const name = await this.promptRequiredText(
            'Generation name (what you want to generate):',
            undefined,
            this.validateName.bind(this),
        );

        const prompt = await this.promptRequiredText(
            'Generation prompt (describe what content to generate):',
            undefined,
            this.validatePrompt.bind(this),
        );

        return { name, prompt };
    }

    private async promptAdvancedOptions(): Promise<Partial<CreateItemsGeneratorDto>> {
        console.log(chalk.cyan('\n--- Advanced Options ---'));

        const options: Partial<CreateItemsGeneratorDto> = {};

        // Company information
        const wantsCompany = await this.promptConfirm(
            'Do you want to specify company information?',
            false,
        );

        if (wantsCompany) {
            options.company = await this.promptCompanyInfo();
        }

        // Categories and keywords
        const wantsCategories = await this.promptConfirm(
            'Do you want to specify initial categories?',
            false,
        );

        if (wantsCategories) {
            options.initial_categories = await this.promptStringArray('Enter initial categories:');
        }

        const wantsPriorityCategories = await this.promptConfirm(
            'Do you want to specify priority categories?',
            false,
        );

        if (wantsPriorityCategories) {
            options.priority_categories = await this.promptStringArray(
                'Enter priority categories:',
            );
        }

        const wantsKeywords = await this.promptConfirm(
            'Do you want to specify target keywords?',
            false,
        );

        if (wantsKeywords) {
            options.target_keywords = await this.promptStringArray('Enter target keywords:');
        }

        // Source URLs
        const wantsSourceUrls = await this.promptConfirm(
            'Do you want to specify source URLs?',
            false,
        );

        if (wantsSourceUrls) {
            options.source_urls = await this.promptUrlArray('Enter source URLs:');
        }

        // Repository description
        const wantsRepoDescription = await this.promptConfirm(
            'Do you want to specify a repository description?',
            false,
        );

        if (wantsRepoDescription) {
            options.repository_description =
                await this.promptOptionalText('Repository description:');
        }

        // Generation method
        const generationMethod = await this.promptSelect(
            'Select generation method:',
            [
                { name: 'Create/Update (recommended)', value: GenerationMethod.CREATE_UPDATE },
                { name: 'Recreate', value: GenerationMethod.RECREATE },
            ],
            GenerationMethod.CREATE_UPDATE,
        );
        options.generation_method = generationMethod;

        // Website repository creation method
        const websiteMethod = await this.promptSelect(
            'Select website repository creation method:',
            [
                {
                    name: 'Duplicate (recommended)',
                    value: WebsiteRepositoryCreationMethod.DUPLICATE,
                },
                { name: 'Fork', value: WebsiteRepositoryCreationMethod.FORK },
                {
                    name: 'Create using template',
                    value: WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                },
            ],
            WebsiteRepositoryCreationMethod.DUPLICATE,
        );
        options.website_repository_creation_method = websiteMethod;

        // Other boolean options
        options.update_with_pull_request = await this.promptConfirm(
            'Update with pull request?',
            true,
        );

        options.badge_evaluation_enabled = await this.promptConfirm(
            'Enable badge evaluation?',
            false,
        );

        // Configuration options
        const wantsConfig = await this.promptConfirm(
            'Do you want to configure advanced generation settings?',
            false,
        );

        if (wantsConfig) {
            options.config = await this.promptConfigOptions();
        }

        return options;
    }

    private async promptCompanyInfo(): Promise<CompanyDto> {
        console.log(chalk.yellow('\nCompany Information:'));

        const name = await this.promptRequiredText(
            'Company name:',
            undefined,
            this.validateName.bind(this),
        );

        const website = await this.promptRequiredText(
            'Company website URL:',
            undefined,
            this.validateUrl.bind(this),
        );

        return { name, website };
    }

    private async promptConfigOptions(): Promise<ConfigDto> {
        console.log(chalk.yellow('\nGeneration Configuration:'));

        const config = new ConfigDto();

        const maxSearchQueries = await this.promptNumber(
            'Max search queries (1-100):',
            config.max_search_queries,
            1,
            100,
        );
        config.max_search_queries = maxSearchQueries;

        const maxResultsPerQuery = await this.promptNumber(
            'Max results per query (1-100):',
            config.max_results_per_query,
            1,
            100,
        );
        config.max_results_per_query = maxResultsPerQuery;

        const maxPagesToProcess = await this.promptNumber(
            'Max pages to process (1-1000):',
            config.max_pages_to_process,
            1,
            1000,
        );
        config.max_pages_to_process = maxPagesToProcess;

        const relevanceThreshold = await this.promptFloat(
            'Relevance threshold for content (0.01-1.0):',
            config.relevance_threshold_content,
            0.01,
            1.0,
        );
        config.relevance_threshold_content = relevanceThreshold;

        const minContentLength = await this.promptNumber(
            'Minimum content length for extraction:',
            config.min_content_length_for_extraction,
            0,
            10000,
        );
        config.min_content_length_for_extraction = minContentLength;

        config.ai_first_generation_enabled = await this.promptConfirm(
            'Enable AI-first generation?',
            config.ai_first_generation_enabled,
        );

        config.content_filtering_enabled = await this.promptConfirm(
            'Enable content filtering?',
            config.content_filtering_enabled,
        );

        const promptComparisonThreshold = await this.promptFloat(
            'Prompt comparison confidence threshold (0.01-1.0):',
            config.prompt_comparison_confidence_threshold,
            0.01,
            1.0,
        );
        config.prompt_comparison_confidence_threshold = promptComparisonThreshold;

        return config;
    }

    private displayGenerationSummary(dto: CreateItemsGeneratorDto): void {
        console.log(chalk.cyan('\n--- Generation Summary ---'));
        console.log(chalk.gray(`Name: ${dto.name}`));
        console.log(chalk.gray(`Prompt: ${dto.prompt}`));

        if (dto.company) {
            console.log(chalk.gray(`Company: ${dto.company.name} (${dto.company.website})`));
        }

        if (dto.initial_categories?.length) {
            console.log(chalk.gray(`Initial Categories: ${dto.initial_categories.join(', ')}`));
        }

        if (dto.priority_categories?.length) {
            console.log(chalk.gray(`Priority Categories: ${dto.priority_categories.join(', ')}`));
        }

        if (dto.target_keywords?.length) {
            console.log(chalk.gray(`Target Keywords: ${dto.target_keywords.join(', ')}`));
        }

        if (dto.source_urls?.length) {
            console.log(chalk.gray(`Source URLs: ${dto.source_urls.length} URLs`));
        }

        if (dto.repository_description) {
            console.log(chalk.gray(`Repository Description: ${dto.repository_description}`));
        }

        console.log(chalk.gray(`Generation Method: ${dto.generation_method}`));
        console.log(
            chalk.gray(`Website Creation Method: ${dto.website_repository_creation_method}`),
        );
        console.log(chalk.gray(`Update with PR: ${dto.update_with_pull_request ? 'Yes' : 'No'}`));
        console.log(chalk.gray(`Badge Evaluation: ${dto.badge_evaluation_enabled ? 'Yes' : 'No'}`));
    }

    // Helper methods for prompting
    private async promptRequiredText(
        message: string,
        defaultValue?: string,
        validator?: (input: string) => string | boolean,
    ): Promise<string> {
        const { value } = await inquirer.prompt({
            type: 'input',
            name: 'value',
            message: chalk.yellow(message),
            default: defaultValue,
            validate: (input: string) => {
                if (!input.trim()) {
                    return 'This field is required';
                }
                return validator ? validator(input.trim()) : true;
            },
        });
        return value.trim();
    }

    private async promptOptionalText(message: string, defaultValue?: string): Promise<string> {
        const { value } = await inquirer.prompt({
            type: 'input',
            name: 'value',
            message: chalk.yellow(message),
            default: defaultValue || '',
        });
        return value.trim();
    }

    private async promptConfirm(message: string, defaultValue: boolean = false): Promise<boolean> {
        const { confirmed } = await inquirer.prompt({
            type: 'confirm',
            name: 'confirmed',
            message: chalk.yellow(message),
            default: defaultValue,
        });
        return confirmed;
    }

    private async promptSelect<T>(
        message: string,
        choices: Array<{ name: string; value: T }>,
        defaultValue?: T,
    ): Promise<T> {
        const { selected } = await inquirer.prompt({
            type: 'list',
            name: 'selected',
            message: chalk.yellow(message),
            choices,
            default: defaultValue,
        });
        return selected;
    }

    private async promptStringArray(message: string): Promise<string[]> {
        console.log(chalk.yellow(message));
        console.log(chalk.gray('(Enter one item per line, press Enter twice when finished)'));

        const items: string[] = [];
        let emptyLineCount = 0;

        while (emptyLineCount < 2) {
            const { item } = await inquirer.prompt({
                type: 'input',
                name: 'item',
                message: items.length === 0 ? '>' : '|',
            });

            if (item.trim() === '') {
                emptyLineCount++;
            } else {
                emptyLineCount = 0;
                items.push(item.trim());
            }
        }

        return items;
    }

    private async promptUrlArray(message: string): Promise<string[]> {
        console.log(chalk.yellow(message));
        console.log(chalk.gray('(Enter one URL per line, press Enter twice when finished)'));

        const urls: string[] = [];
        let emptyLineCount = 0;

        while (emptyLineCount < 2) {
            const { url } = await inquirer.prompt({
                type: 'input',
                name: 'url',
                message: urls.length === 0 ? '>' : '|',
                validate: (input: string) => {
                    if (input.trim() === '') {
                        return true; // Allow empty for finishing
                    }
                    return this.validateUrl(input.trim());
                },
            });

            if (url.trim() === '') {
                emptyLineCount++;
            } else {
                emptyLineCount = 0;
                urls.push(url.trim());
            }
        }

        return urls;
    }

    private async promptNumber(
        message: string,
        defaultValue: number,
        min: number,
        max: number,
    ): Promise<number> {
        const { value } = await inquirer.prompt({
            type: 'number',
            name: 'value',
            message: chalk.yellow(message),
            default: defaultValue,
            validate: (input: number) => {
                if (isNaN(input) || input < min || input > max) {
                    return `Please enter a number between ${min} and ${max}`;
                }
                return true;
            },
        });
        return value;
    }

    private async promptFloat(
        message: string,
        defaultValue: number,
        min: number,
        max: number,
    ): Promise<number> {
        const { value } = await inquirer.prompt({
            type: 'input',
            name: 'value',
            message: chalk.yellow(message),
            default: defaultValue.toString(),
            validate: (input: string) => {
                const num = parseFloat(input);
                if (isNaN(num) || num < min || num > max) {
                    return `Please enter a number between ${min} and ${max}`;
                }
                return true;
            },
        });
        return parseFloat(value);
    }

    // Validation methods
    private validateName(name: string): string | boolean {
        if (name.length < 2) {
            return 'Name must be at least 2 characters long';
        }
        if (name.length > 100) {
            return 'Name must be less than 100 characters';
        }
        return true;
    }

    private validatePrompt(prompt: string): string | boolean {
        if (prompt.length < 10) {
            return 'Prompt must be at least 10 characters long';
        }
        if (prompt.length > 1000) {
            return 'Prompt must be less than 1000 characters';
        }
        return true;
    }

    private validateUrl(url: string): string | boolean {
        try {
            new URL(url);
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                return 'URL must start with http:// or https://';
            }
            return true;
        } catch {
            return 'Please enter a valid URL';
        }
    }
}
