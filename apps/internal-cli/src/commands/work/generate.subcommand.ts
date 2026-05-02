import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { WorkRepository, UserRepository } from '@ever-works/agent/database';
import { WorkGenerationService, WorkQueryService } from '@ever-works/agent/services';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@ever-works/agent/items-generator';
import { WorkPromptService } from './work-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';
import { Work, GenerateStatusType, User } from '@ever-works/agent/entities';
import {
    getDynamicStepText,
    getDynamicStepProgress,
    getItemsProcessedText,
} from '@ever-works/cli-shared';

@SubCommand({
    name: 'generate',
    description: 'Generate data and create a repository for a work',
})
export class GenerateSubCommand extends CommandRunner {
    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workGenerationService: WorkGenerationService,
        private readonly workQueryService: WorkQueryService,
        private readonly workPrompt: WorkPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nGenerate Work Content\n'));
            console.log(
                chalk.gray(
                    'This process may take a while. Please be patient and do not interrupt.',
                ),
            );

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Get user information
            const user = await this.userRepository.createOrGetLocalUser();

            // Select work
            const selection = await this.workPrompt.promptWorkSelection(
                this.workRepository,
            );

            if (selection.cancelled || !selection.work) {
                console.log(chalk.blue('\nℹ Generation cancelled.'));
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

            if (work.generateStatus?.status === 'generating') {
                console.log(chalk.yellow('\n⚠ Generation already in progress.'));
                if (work.generateStatus.step) {
                    console.log(
                        chalk.gray('Current step:'),
                        chalk.white(work.generateStatus.step),
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

                const generatorPromise = this.workGenerationService.generateItems(
                    work.id,
                    createDto,
                    user,
                    true,
                );
                const checkStatus = this.generationStatus(spinner, user, work);

                const [result] = await Promise.all([generatorPromise, checkStatus()]);

                spinner.stop();

                if (result.status === 'error') {
                    console.log(chalk.red('\n✗ Generation failed'));
                    console.log(chalk.gray(`  Status: ${result.status}`));
                    console.log(chalk.gray(`  Work: ${result.slug}`));
                    console.log(chalk.gray(`  Message: ${result.message}`));
                } else {
                    console.log(chalk.green('\n✓ Generation process finished!'));
                    console.log(chalk.gray('\nGeneration Details:'));
                    console.log(chalk.gray(`  Status: ${result.status}`));
                    console.log(chalk.gray(`  Work: ${result.slug}`));

                    if (result.message) {
                        console.log(chalk.gray(`  Message: ${result.message}`));
                    }

                    console.log(
                        chalk.gray('  • Use ') +
                            chalk.cyan('work list') +
                            chalk.gray(' to see your works'),
                    );
                }
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to generate work content');
            process.exit(1);
        }
    }

    private generationStatus(spinner: ora.Ora, user: User, work: Work) {
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

                const { work: freshWork } = await this.workQueryService.getWork(
                    work.id,
                    user,
                );

                if (freshWork.generateStatus?.status === GenerateStatusType.GENERATED) {
                    spinner.succeed('\n✓ Generation process finished!');
                    spinner.stop();

                    // Show additional info if available
                    console.log(chalk.cyan('\n--- Generation Complete ---'));
                    console.log(chalk.gray('  • Work is ready for use'));
                } else if (freshWork.generateStatus?.status === GenerateStatusType.ERROR) {
                    spinner.fail('\n✗ Generation failed');

                    if (freshWork.generateStatus?.error) {
                        console.log(chalk.red(`Error: ${freshWork.generateStatus.error}`));
                    }
                    spinner.stop();
                } else if (freshWork.generateStatus?.status === GenerateStatusType.CANCELLED) {
                    spinner.warn('\n⚠ Generation cancelled');

                    if (freshWork.generateStatus?.error) {
                        console.log(chalk.yellow(freshWork.generateStatus.error));
                    }
                    spinner.stop();
                } else {
                    // Update spinner text with current step
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const timeStr = `[${Math.floor(elapsed / 60)}m ${elapsed % 60}s]`;

                    if (freshWork.generateStatus?.step) {
                        const stepText = getDynamicStepText(freshWork.generateStatus);
                        const progress = getDynamicStepProgress(freshWork.generateStatus);
                        const itemsText = getItemsProcessedText(freshWork.generateStatus);
                        const itemsSuffix = itemsText ? ` (${itemsText})` : '';

                        spinner.text = `Generating ${timeStr}: ${stepText}${itemsSuffix} - ${progress}%`;
                    } else {
                        spinner.text = `Generating ${timeStr}...`;
                    }

                    // Poll again after interval
                    setTimeout(checkStatus, POLL_INTERVAL);
                }
            } catch (error) {
                spinner.fail('Failed to fetch work status');
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
