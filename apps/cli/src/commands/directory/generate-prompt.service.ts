import chalk from 'chalk';
import inquirer from 'inquirer';
import { BasePromptService } from '@packages/cli-shared';
import { CreateItemsGeneratorDto } from '../../services/api.service';

export interface CompanyDto {
    name: string;
    website: string;
}

export interface ConfigDto {
    max_search_queries: number;
    max_results_per_query: number;
    max_pages_to_process: number;
    relevance_threshold_content: number;
    min_content_length_for_extraction: number;
    ai_first_generation_enabled: boolean;
    content_filtering_enabled: boolean;
    prompt_comparison_confidence_threshold: number;
}

export enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

export enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    CREATE_USING_TEMPLATE = 'create-using-template',
}

export class GeneratePromptService extends BasePromptService {
    /**
     * Prompts for required generation fields
     */
    async promptRequiredFields(defaultName: string): Promise<{
        name: string;
        prompt: string;
    }> {
        this.displaySectionHeader('Required Fields');

        const name = await this.promptRequiredText(
            'Generation name:',
            defaultName,
            this.validateName.bind(this),
        );

        const prompt = await this.promptRequiredText(
            'Generation prompt (describe what you want to generate):',
            undefined,
            this.validatePrompt.bind(this),
        );

        return { name, prompt };
    }

    /**
     * Prompts for advanced generation options
     */
    async promptAdvancedOptions(): Promise<Partial<CreateItemsGeneratorDto>> {
        this.displaySectionHeader('Advanced Options');

        const options: Partial<CreateItemsGeneratorDto> = {};

        // Generation method
        options.generation_method = await this.promptSelect(
            'Generation method:',
            [
                { name: 'Create/Update (recommended)', value: GenerationMethod.CREATE_UPDATE },
                { name: 'Recreate (replace existing)', value: GenerationMethod.RECREATE },
            ],
            GenerationMethod.CREATE_UPDATE,
        );

        // Website repository creation method
        options.website_repository_creation_method = await this.promptSelect(
            'Website repository creation method:',
            [
                {
                    name: 'Duplicate (recommended)',
                    value: WebsiteRepositoryCreationMethod.DUPLICATE,
                },
                {
                    name: 'Create using template',
                    value: WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                },
            ],
            WebsiteRepositoryCreationMethod.DUPLICATE,
        );

        // Repository description
        options.repository_description = await this.promptOptionalText(
            'Repository description (optional):',
        );

        // Categories
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

        // Keywords
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

        // Update with pull request
        options.update_with_pull_request = await this.promptConfirm(
            'Update with pull request?',
            true,
        );

        // Badge evaluation
        options.badge_evaluation_enabled = await this.promptConfirm(
            'Enable badge evaluation?',
            false,
        );

        return options;
    }

    /**
     * Prompts for company information
     */
    async promptCompanyInfo(): Promise<CompanyDto> {
        this.displayInfo('Company Information');

        const name = await this.promptRequiredText(
            'Company name:',
            undefined,
            this.validateName.bind(this),
        );

        const website = await this.promptRequiredText(
            'Company website:',
            undefined,
            this.validateUrl.bind(this),
        );

        return { name, website };
    }

    /**
     * Prompts for configuration options
     */
    async promptConfigOptions(): Promise<ConfigDto> {
        this.displayInfo('Generation Configuration');

        const config: ConfigDto = {
            max_search_queries: 10,
            max_results_per_query: 20,
            max_pages_to_process: 10,
            relevance_threshold_content: 0.5,
            min_content_length_for_extraction: 300,
            ai_first_generation_enabled: true,
            content_filtering_enabled: true,
            prompt_comparison_confidence_threshold: 0.5,
        };

        config.max_search_queries = await this.promptNumberMinMax(
            'Max search queries (1-100):',
            config.max_search_queries,
            1,
            100,
        );

        config.max_results_per_query = await this.promptNumberMinMax(
            'Max results per query (1-100):',
            config.max_results_per_query,
            1,
            100,
        );

        config.max_pages_to_process = await this.promptNumberMinMax(
            'Max pages to process (1-1000):',
            config.max_pages_to_process,
            1,
            1000,
        );

        config.relevance_threshold_content = await this.promptFloat(
            'Relevance threshold for content (0.01-1.0):',
            config.relevance_threshold_content,
            0.01,
            1.0,
        );

        config.min_content_length_for_extraction = await this.promptNumberMinMax(
            'Minimum content length for extraction:',
            config.min_content_length_for_extraction,
            0,
            10000,
        );

        config.ai_first_generation_enabled = await this.promptConfirm(
            'Enable AI-first generation?',
            config.ai_first_generation_enabled,
        );

        config.content_filtering_enabled = await this.promptConfirm(
            'Enable content filtering?',
            config.content_filtering_enabled,
        );

        config.prompt_comparison_confidence_threshold = await this.promptFloat(
            'Prompt comparison confidence threshold (0.01-1.0):',
            config.prompt_comparison_confidence_threshold,
            0.01,
            1.0,
        );

        return config;
    }

    /**
     * Displays generation summary
     */
    displayGenerationSummary(dto: CreateItemsGeneratorDto): void {
        this.displaySectionHeader('Generation Summary');
        console.log(chalk.gray('Name:'), chalk.white(dto.name));
        console.log(chalk.gray('Prompt:'), chalk.white(dto.prompt));

        if (dto.company) {
            console.log(
                chalk.gray('Company:'),
                chalk.white(`${dto.company.name} (${dto.company.website})`),
            );
        }

        if (dto.initial_categories?.length) {
            console.log(
                chalk.gray('Initial Categories:'),
                chalk.white(dto.initial_categories.join(', ')),
            );
        }

        if (dto.priority_categories?.length) {
            console.log(
                chalk.gray('Priority Categories:'),
                chalk.white(dto.priority_categories.join(', ')),
            );
        }

        if (dto.target_keywords?.length) {
            console.log(
                chalk.gray('Target Keywords:'),
                chalk.white(dto.target_keywords.join(', ')),
            );
        }

        if (dto.source_urls?.length) {
            console.log(chalk.gray('Source URLs:'), chalk.white(`${dto.source_urls.length} URLs`));
        }

        if (dto.repository_description) {
            console.log(
                chalk.gray('Repository Description:'),
                chalk.white(dto.repository_description),
            );
        }

        if (dto.generation_method) {
            console.log(chalk.gray('Generation Method:'), chalk.white(dto.generation_method));
        }

        if (dto.website_repository_creation_method) {
            console.log(
                chalk.gray('Website Creation Method:'),
                chalk.white(dto.website_repository_creation_method),
            );
        }

        console.log(
            chalk.gray('Update with PR:'),
            chalk.white(dto.update_with_pull_request !== false ? 'Yes' : 'No'),
        );

        console.log(
            chalk.gray('Badge Evaluation:'),
            chalk.white(dto.badge_evaluation_enabled ? 'Yes' : 'No'),
        );

        if (dto.config) {
            console.log(chalk.gray('Advanced Config:'), chalk.white('Configured'));
        }
    }

    // Helper methods for prompting
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
}
