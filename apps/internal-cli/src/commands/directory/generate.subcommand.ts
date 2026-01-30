import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { DirectoryGenerationService, DirectoryQueryService } from '@packages/agent/services';
import {
    CreateItemsGeneratorDto,
    CompanyDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@packages/agent/items-generator';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';
import { Directory, GenerateStatusType, User } from '@packages/agent/entities';
import { getStepProgress, getStepText, ItemsGeneratorStep } from '@packages/cli-shared';

@SubCommand({
    name: 'generate',
    description: 'Generate data and create a GitHub repository for a directory',
})
export class GenerateSubCommand extends CommandRunner {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryGenerationService: DirectoryGenerationService,
        private readonly directoryQueryService: DirectoryQueryService,
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

            // Get user information
            const user = await this.userRepository.createOrGetLocalUser();
            const token = user.getGitToken();
            if (!token) {
                throw new Error('GitHub token is required');
            }

            // Select directory
            const selection = await this.directoryPrompt.promptDirectorySelection(
                this.directoryRepository,
            );

            if (selection.cancelled || !selection.directory) {
                console.log(chalk.blue('\nℹ Generation cancelled.'));
                return;
            }

            const directory = selection.directory;
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected directory: ${this.directoryPrompt.formatSelectedDirectory(directory, role, isShared)}`,
                ),
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

                const generatorPromise = this.directoryGenerationService.generateItems(
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

                const { directory: freshDirectory } = await this.directoryQueryService.getDirectory(
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
                } else if (freshDirectory.generateStatus?.status === GenerateStatusType.CANCELLED) {
                    spinner.warn('\n⚠ Generation cancelled');

                    if (freshDirectory.generateStatus?.error) {
                        console.log(chalk.yellow(freshDirectory.generateStatus.error));
                    }
                    spinner.stop();
                } else {
                    // Update spinner text with current step
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const timeStr = `[${Math.floor(elapsed / 60)}m ${elapsed % 60}s]`;

                    if (freshDirectory.generateStatus?.step) {
                        const step = freshDirectory.generateStatus.step as ItemsGeneratorStep;
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
        const pluginConfig: Record<string, unknown> = {};

        // Company information (core field)
        const wantsCompany = await this.promptConfirm(
            'Do you want to specify company information?',
            false,
        );

        if (wantsCompany) {
            options.company = await this.promptCompanyInfo();
        }

        // Categories and keywords (pipeline-specific fields -> pluginConfig)
        const wantsCategories = await this.promptConfirm(
            'Do you want to specify initial categories?',
            false,
        );

        if (wantsCategories) {
            pluginConfig.initial_categories = await this.promptStringArray(
                'Enter initial categories:',
            );
        }

        const wantsPriorityCategories = await this.promptConfirm(
            'Do you want to specify priority categories?',
            false,
        );

        if (wantsPriorityCategories) {
            pluginConfig.priority_categories = await this.promptStringArray(
                'Enter priority categories:',
            );
        }

        const wantsKeywords = await this.promptConfirm(
            'Do you want to specify target keywords?',
            false,
        );

        if (wantsKeywords) {
            pluginConfig.target_keywords = await this.promptStringArray('Enter target keywords:');
        }

        // Source URLs (pipeline-specific -> pluginConfig)
        const wantsSourceUrls = await this.promptConfirm(
            'Do you want to specify source URLs?',
            false,
        );

        if (wantsSourceUrls) {
            pluginConfig.source_urls = await this.promptUrlArray('Enter source URLs:');
        }

        // Repository description (core field)
        const wantsRepoDescription = await this.promptConfirm(
            'Do you want to specify a repository description?',
            false,
        );

        if (wantsRepoDescription) {
            options.repository_description =
                await this.promptOptionalText('Repository description:');
        }

        // Generation method (core field)
        const generationMethod = await this.promptSelect(
            'Select generation method:',
            [
                { name: 'Create/Update (recommended)', value: GenerationMethod.CREATE_UPDATE },
                { name: 'Recreate', value: GenerationMethod.RECREATE },
            ],
            GenerationMethod.CREATE_UPDATE,
        );
        options.generation_method = generationMethod;

        // Website repository creation method (core field)
        const websiteMethod = await this.promptSelect(
            'Select website repository creation method:',
            [
                {
                    name: 'Create using template (recommended)',
                    value: WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                },
                {
                    name: 'Duplicate',
                    value: WebsiteRepositoryCreationMethod.DUPLICATE,
                },
            ],
            WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
        );
        options.website_repository_creation_method = websiteMethod;

        // Other boolean options (core field)
        options.update_with_pull_request = await this.promptConfirm(
            'Update with pull request?',
            true,
        );

        // Badge evaluation (pipeline-specific -> pluginConfig)
        pluginConfig.badge_evaluation_enabled = await this.promptConfirm(
            'Enable badge evaluation?',
            false,
        );

        // Configuration options (pipeline-specific -> pluginConfig)
        const wantsConfig = await this.promptConfirm(
            'Do you want to configure advanced generation settings?',
            false,
        );

        if (wantsConfig) {
            pluginConfig.config = await this.promptConfigOptions();
        }

        // Only add pluginConfig if there are any values
        if (Object.keys(pluginConfig).length > 0) {
            options.pluginConfig = pluginConfig;
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

    private async promptConfigOptions(): Promise<Record<string, unknown>> {
        console.log(chalk.yellow('\nGeneration Configuration:'));

        // Default values for config options
        const defaults = {
            max_search_queries: 10,
            max_results_per_query: 10,
            max_pages_to_process: 100,
            relevance_threshold_content: 0.5,
            min_content_length_for_extraction: 100,
            ai_first_generation_enabled: false,
            content_filtering_enabled: true,
            prompt_comparison_confidence_threshold: 0.7,
        };

        const config: Record<string, unknown> = {};

        config.max_search_queries = await this.promptNumber(
            'Max search queries (1-100):',
            defaults.max_search_queries,
            1,
            100,
        );

        config.max_results_per_query = await this.promptNumber(
            'Max results per query (1-100):',
            defaults.max_results_per_query,
            1,
            100,
        );

        config.max_pages_to_process = await this.promptNumber(
            'Max pages to process (1-1000):',
            defaults.max_pages_to_process,
            1,
            1000,
        );

        config.relevance_threshold_content = await this.promptFloat(
            'Relevance threshold for content (0.01-1.0):',
            defaults.relevance_threshold_content,
            0.01,
            1.0,
        );

        config.min_content_length_for_extraction = await this.promptNumber(
            'Minimum content length for extraction:',
            defaults.min_content_length_for_extraction,
            0,
            10000,
        );

        config.ai_first_generation_enabled = await this.promptConfirm(
            'Enable AI-first generation?',
            defaults.ai_first_generation_enabled,
        );

        config.content_filtering_enabled = await this.promptConfirm(
            'Enable content filtering?',
            defaults.content_filtering_enabled,
        );

        config.prompt_comparison_confidence_threshold = await this.promptFloat(
            'Prompt comparison confidence threshold (0.01-1.0):',
            defaults.prompt_comparison_confidence_threshold,
            0.01,
            1.0,
        );

        return config;
    }

    private displayGenerationSummary(dto: CreateItemsGeneratorDto): void {
        console.log(chalk.cyan('\n--- Generation Summary ---'));
        console.log(chalk.gray(`Name: ${dto.name}`));
        console.log(chalk.gray(`Prompt: ${dto.prompt}`));

        if (dto.company) {
            console.log(chalk.gray(`Company: ${dto.company.name} (${dto.company.website})`));
        }

        // Access pipeline-specific fields from pluginConfig
        const config = dto.pluginConfig as Record<string, unknown> | undefined;

        const initialCategories = config?.initial_categories as string[] | undefined;
        if (initialCategories?.length) {
            console.log(chalk.gray(`Initial Categories: ${initialCategories.join(', ')}`));
        }

        const priorityCategories = config?.priority_categories as string[] | undefined;
        if (priorityCategories?.length) {
            console.log(chalk.gray(`Priority Categories: ${priorityCategories.join(', ')}`));
        }

        const targetKeywords = config?.target_keywords as string[] | undefined;
        if (targetKeywords?.length) {
            console.log(chalk.gray(`Target Keywords: ${targetKeywords.join(', ')}`));
        }

        const sourceUrls = config?.source_urls as string[] | undefined;
        if (sourceUrls?.length) {
            console.log(chalk.gray(`Source URLs: ${sourceUrls.length} URLs`));
        }

        if (dto.repository_description) {
            console.log(chalk.gray(`Repository Description: ${dto.repository_description}`));
        }

        console.log(chalk.gray(`Generation Method: ${dto.generation_method}`));
        console.log(
            chalk.gray(`Website Creation Method: ${dto.website_repository_creation_method}`),
        );
        console.log(chalk.gray(`Update with PR: ${dto.update_with_pull_request ? 'Yes' : 'No'}`));

        const badgeEnabled = config?.badge_evaluation_enabled as boolean | undefined;
        console.log(chalk.gray(`Badge Evaluation: ${badgeEnabled ? 'Yes' : 'No'}`));
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
