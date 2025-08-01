import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository } from '@packages/agent/database';
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
import { User } from '@packages/agent/entities';

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
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n🚀 Generate Directory Content\n'));
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
                slug: directory.slug,
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
                const user = await User.sessionMock();

                const result = await this.agentService.generateItemsGenerator(
                    createDto,
                    user,
                    true,
                );
                spinner.succeed('Generation started successfully');

                console.log(chalk.green('\n✓ Generation process started!'));
                console.log(chalk.gray('\nGeneration Details:'));
                console.log(chalk.gray(`  Status: ${result.status}`));
                console.log(chalk.gray(`  Directory: ${result.slug}`));
                console.log(chalk.gray(`  Message: ${result.message}`));

                console.log(chalk.cyan('\nNext Steps:'));
                console.log(chalk.gray('  • The generation process is running in the background'));
                console.log(
                    chalk.gray('  • Check the logs or data directory for progress updates'),
                );
                console.log(
                    chalk.gray('  • Use ') +
                        chalk.cyan('directory list') +
                        chalk.gray(' to see your directories'),
                );
            } catch (error) {
                spinner.fail('Generation failed');
                throw error;
            }
        } catch (error) {
            this.logger.error('Failed to generate directory content:', error);
            console.log(chalk.red('\n✗ Failed to generate directory content:'), error.message);
        }
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
        console.log(chalk.gray(`Directory: ${dto.slug}`));
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
