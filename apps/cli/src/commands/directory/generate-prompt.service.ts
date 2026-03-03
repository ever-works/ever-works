import chalk from 'chalk';
import inquirer from 'inquirer';
import { BasePromptService } from '@ever-works/cli-shared';
import type {
    CreateItemsGeneratorDto,
    GeneratorFormSchema,
    ProvidersDto,
    FormFieldDefinition,
    FormFieldGroup,
} from '../../services/api.service';
import { GenerationMethod, WebsiteRepositoryCreationMethod } from '../../services/api.service';
import type { FormFieldCondition } from '@ever-works/contracts';
import {
    getIndividualProviderCategories,
    resolveEffectiveDefault,
    type IndividualCategoryKey,
} from '@ever-works/plugin';

export interface ProviderSelectionResult {
    providers: Partial<ProvidersDto>;
    pipelineId: string | null;
}

export class GeneratePromptService extends BasePromptService {
    /**
     * Prompts for required generation fields
     */
    async promptRequiredFields(
        directoryName: string,
        defaultPrompt?: string,
    ): Promise<{
        name: string;
        prompt: string;
    }> {
        this.displaySectionHeader('Required Fields');

        console.log(chalk.gray('Generation name:'), chalk.white(directoryName));

        const prompt = await this.promptRequiredText(
            'Generation prompt (describe what you want to generate):',
            defaultPrompt,
            this.validatePrompt.bind(this),
        );

        return { name: directoryName, prompt };
    }

    /**
     * Prompts for provider selection based on the generator form schema.
     * Mirrors the web: pipeline selector first (when >1 available), then individual providers.
     */
    async promptProviderSelection(
        schema: GeneratorFormSchema,
        initialProviders?: Partial<ProvidersDto>,
        resolvedPipelineId?: string,
    ): Promise<ProviderSelectionResult> {
        this.displaySectionHeader('Provider Selection');

        const providers: Partial<ProvidersDto> = {};
        let pipelineId: string | null = null;

        // Pipeline selection (shown when >1 pipeline available, matching web's PipelineModeSelector)
        const pipelines = schema.providers.pipeline || [];
        if (pipelines.length > 1) {
            const defaultPipeline = pipelines.find((p) => p.isDefault);
            const choices: Array<{ name: string; value: string }> = [];

            for (const pipeline of pipelines) {
                if (pipeline.configured) {
                    choices.push({
                        name: `${pipeline.name}${pipeline.isDefault ? ' (default)' : ''}${pipeline.description ? chalk.gray(` — ${pipeline.description}`) : ''}`,
                        value: pipeline.id,
                    });
                } else {
                    choices.push({
                        name: chalk.gray(`${pipeline.name} (not configured)`),
                        value: `__disabled__${pipeline.id}`,
                    });
                }
            }

            // Default: initialProviders > resolvedPipelineId > schema default > first pipeline
            const initialPipelineId = initialProviders?.pipeline;
            const pipelineDefault =
                (initialPipelineId && pipelines.some((p) => p.id === initialPipelineId)
                    ? initialPipelineId
                    : undefined) ||
                (resolvedPipelineId && pipelines.some((p) => p.id === resolvedPipelineId)
                    ? resolvedPipelineId
                    : undefined) ||
                defaultPipeline?.id ||
                pipelines[0].id;

            let selectedPipeline = await this.promptSelect('Pipeline:', choices, pipelineDefault);

            while (selectedPipeline.startsWith('__disabled__')) {
                console.log(
                    chalk.yellow(
                        '  This pipeline is not configured. Please configure it in Settings > Plugins.',
                    ),
                );
                selectedPipeline = await this.promptSelect(
                    'Pipeline:',
                    choices,
                    defaultPipeline?.id || pipelines[0].id,
                );
            }

            providers.pipeline = selectedPipeline;
            pipelineId = selectedPipeline;
        }

        // Individual provider categories
        const cliLabels: Record<IndividualCategoryKey, string> = {
            ai: 'AI Provider',
            search: 'Search Provider',
            screenshot: 'Screenshot Provider',
            contentExtractor: 'Content Extractor',
        };
        const categories = getIndividualProviderCategories().map(({ uiKey }) => ({
            key: uiKey as keyof ProvidersDto,
            label: cliLabels[uiKey as IndividualCategoryKey],
            options: schema.providers[uiKey as keyof GeneratorFormSchema['providers']],
        }));

        for (const category of categories) {
            if (!category.options || category.options.length <= 1) continue;

            const defaultProvider = resolveEffectiveDefault(
                category.options.filter((p) => p.configured),
            );
            const autoLabel = defaultProvider ? `Auto (${defaultProvider.name})` : 'Auto (default)';
            const choices: Array<{ name: string; value: string }> = [
                { name: autoLabel, value: '' },
            ];

            for (const provider of category.options) {
                if (provider.configured) {
                    choices.push({
                        name: `${provider.name}${provider.isDefault ? ' (default)' : ''}`,
                        value: provider.id,
                    });
                } else {
                    choices.push({
                        name: chalk.gray(`${provider.name} (not configured)`),
                        value: `__disabled__${provider.id}`,
                    });
                }
            }

            // Default to initialProviders value if the provider is in the available options
            const initialValue = initialProviders?.[category.key];
            const categoryDefault =
                initialValue && category.options.some((p) => p.id === initialValue)
                    ? initialValue
                    : '';

            let selected = await this.promptSelect(`${category.label}:`, choices, categoryDefault);

            while (selected.startsWith('__disabled__')) {
                console.log(
                    chalk.yellow(
                        '  This provider is not configured. Please configure it in Settings > Plugins.',
                    ),
                );
                selected = await this.promptSelect(`${category.label}:`, choices, '');
            }

            if (selected) {
                providers[category.key] = selected;
            }
        }

        return { providers, pipelineId };
    }

    /**
     * Prompts for generation method, PR option, and website repo creation method
     */
    async promptGenerationOptions(defaults?: {
        generation_method?: GenerationMethod;
        update_with_pull_request?: boolean;
        website_repository_creation_method?: WebsiteRepositoryCreationMethod;
    }): Promise<{
        generation_method: GenerationMethod;
        update_with_pull_request: boolean;
        website_repository_creation_method: WebsiteRepositoryCreationMethod;
    }> {
        const generation_method = await this.promptSelect(
            'Generation method:',
            [
                { name: 'Create/Update (incremental)', value: GenerationMethod.CREATE_UPDATE },
                { name: 'Recreate (full rebuild)', value: GenerationMethod.RECREATE },
            ],
            defaults?.generation_method ?? GenerationMethod.CREATE_UPDATE,
        );

        const update_with_pull_request = await this.promptConfirm(
            'Update with pull request?',
            defaults?.update_with_pull_request ?? false,
        );

        const website_repository_creation_method = await this.promptSelect(
            'Website repository creation method:',
            [
                {
                    name: 'Create using template',
                    value: WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                },
                { name: 'Duplicate', value: WebsiteRepositoryCreationMethod.DUPLICATE },
            ],
            defaults?.website_repository_creation_method ??
                WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
        );

        return { generation_method, update_with_pull_request, website_repository_creation_method };
    }

    /**
     * Prompts for dynamic plugin form fields
     */
    async promptDynamicFields(
        fields: FormFieldDefinition[],
        groups?: FormFieldGroup[],
        defaults?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        if (!fields || fields.length === 0) return {};

        // Deduplicate fields by name (first occurrence wins), matching web behavior
        const seen = new Set<string>();
        const uniqueFields = fields.filter((f) => {
            if (seen.has(f.name)) return false;
            seen.add(f.name);
            return true;
        });

        const values: Record<string, unknown> = { ...defaults };

        // Deduplicate groups by name (first occurrence wins)
        const seenGroups = new Set<string>();
        const sortedGroups = [...(groups || [])]
            .filter((g) => {
                if (seenGroups.has(g.name)) return false;
                seenGroups.add(g.name);
                return true;
            })
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        const ungroupedFields = uniqueFields.filter((f) => !f.group);

        // Prompt ungrouped fields
        for (const field of ungroupedFields) {
            await this.promptField(field, values, defaults);
        }

        // Prompt grouped fields
        for (const group of sortedGroups) {
            const groupFields = uniqueFields.filter((f) => f.group === group.name);

            if (groupFields.length === 0) continue;

            if (group.collapsible) {
                const configure = await this.promptConfirm(
                    `Configure ${group.title}?${group.description ? ` (${group.description})` : ''}`,
                    !(group.collapsed ?? false),
                );

                if (!configure) {
                    // Use defaults for skipped group
                    for (const field of groupFields) {
                        if (field.defaultValue !== undefined) {
                            values[field.name] = field.defaultValue;
                        }
                    }
                    continue;
                }
            } else {
                console.log(chalk.cyan.bold(`\n  ${group.title}`));
                if (group.description) {
                    console.log(chalk.gray(group.description));
                }
            }

            for (const field of groupFields) {
                await this.promptField(field, values, defaults);
            }
        }

        return values;
    }

    /**
     * Displays generation summary
     */
    displayGenerationSummary(dto: CreateItemsGeneratorDto): void {
        this.displaySectionHeader('Generation Summary');
        console.log(chalk.gray('Name:'), chalk.white(dto.name));
        console.log(chalk.gray('Prompt:'), chalk.white(dto.prompt));

        if (dto.providers) {
            const providerEntries = Object.entries(dto.providers).filter(([, v]) => v);
            if (providerEntries.length > 0) {
                console.log(chalk.gray('Providers:'));
                for (const [key, value] of providerEntries) {
                    console.log(chalk.gray(`  ${key}:`), chalk.white(value as string));
                }
            }
        }

        if (dto.generation_method) {
            console.log(chalk.gray('Generation Method:'), chalk.white(dto.generation_method));
        }

        if (dto.pluginConfig) {
            const configCount = Object.keys(dto.pluginConfig).length;
            if (configCount > 0) {
                console.log(
                    chalk.gray('Plugin Config:'),
                    chalk.white(`${configCount} field(s) configured`),
                );
            }
        }

        console.log(
            chalk.gray('Update with PR:'),
            chalk.white(dto.update_with_pull_request ? 'Yes' : 'No'),
        );

        if (dto.website_repository_creation_method) {
            console.log(
                chalk.gray('Website Repo Method:'),
                chalk.white(dto.website_repository_creation_method),
            );
        }
    }

    /**
     * Prompts for a single form field based on its type
     */
    private async promptField(
        field: FormFieldDefinition,
        values: Record<string, unknown>,
        defaults?: Record<string, unknown>,
    ): Promise<void> {
        // Evaluate showIf conditions
        if (field.showIf && !this.evaluateConditions(field.showIf, values)) {
            if (field.defaultValue !== undefined) {
                values[field.name] = field.defaultValue;
            }
            return;
        }

        // Skip hidden fields, use default
        if (field.type === 'hidden') {
            values[field.name] = defaults?.[field.name] ?? field.defaultValue;
            return;
        }

        // Skip disabled/readOnly fields
        if (field.disabled || field.readOnly) {
            values[field.name] = defaults?.[field.name] ?? field.defaultValue;
            return;
        }

        const defaultValue = defaults?.[field.name] ?? field.defaultValue;
        const label =
            field.label + (field.description ? chalk.gray(` (${field.description})`) : '');

        switch (field.type) {
            case 'text':
            case 'textarea':
            case 'url':
            case 'email': {
                const validator =
                    field.type === 'url'
                        ? this.validateUrl.bind(this)
                        : field.type === 'email'
                          ? this.validateEmail.bind(this)
                          : undefined;

                if (field.validation?.required) {
                    values[field.name] = await this.promptRequiredText(
                        `${label}:`,
                        defaultValue as string | undefined,
                        validator,
                    );
                } else {
                    values[field.name] = await this.promptOptionalText(
                        `${label}:`,
                        defaultValue as string | undefined,
                        validator,
                    );
                }
                break;
            }

            case 'number':
            case 'range': {
                const min = field.validation?.min;
                const max = field.validation?.max;
                values[field.name] = await this.promptNumberMinMax(
                    `${label}:`,
                    defaultValue as number | undefined,
                    min,
                    max,
                );
                break;
            }

            case 'boolean': {
                values[field.name] = await this.promptConfirm(
                    `${label}:`,
                    (defaultValue as boolean) ?? false,
                );
                break;
            }

            case 'select': {
                if (field.options && field.options.length > 0) {
                    const choices = field.options.map((opt) => ({
                        name:
                            opt.label +
                            (opt.description ? chalk.gray(` - ${opt.description}`) : ''),
                        value: String(opt.value),
                    }));
                    values[field.name] = await this.promptSelect(
                        `${label}:`,
                        choices,
                        defaultValue != null ? String(defaultValue) : undefined,
                    );
                }
                break;
            }

            case 'multiselect': {
                if (field.options && field.options.length > 0) {
                    const choices = field.options.map((opt) => ({
                        name: opt.label,
                        value: String(opt.value),
                        checked: Array.isArray(defaultValue)
                            ? defaultValue.includes(opt.value)
                            : false,
                    }));
                    values[field.name] = await this.promptMultiSelect(`${label}:`, choices);
                }
                break;
            }

            case 'password': {
                values[field.name] = await this.promptPassword(`${label}:`);
                break;
            }

            case 'tags': {
                const { value } = await inquirer.prompt({
                    type: 'input',
                    name: 'value',
                    message: `${label} (comma-separated):`,
                    default: Array.isArray(defaultValue)
                        ? (defaultValue as string[]).join(', ')
                        : (defaultValue as string),
                });
                values[field.name] = value
                    ? String(value)
                          .split(',')
                          .map((s: string) => s.trim())
                          .filter(Boolean)
                    : [];
                break;
            }

            default: {
                // Fallback: treat as text input
                values[field.name] = await this.promptOptionalText(
                    `${label}:`,
                    defaultValue as string | undefined,
                );
                break;
            }
        }
    }

    /**
     * Evaluates showIf conditions against current values
     */
    private evaluateConditions(
        conditions: FormFieldCondition | readonly FormFieldCondition[],
        values: Record<string, unknown>,
    ): boolean {
        const conditionArray = Array.isArray(conditions) ? conditions : [conditions];

        return conditionArray.every((condition) => {
            const fieldValue = values[condition.field];

            const op = condition.operator as string;
            switch (op) {
                case 'eq':
                    return fieldValue === condition.value;
                case 'neq':
                case 'ne':
                    return fieldValue !== condition.value;
                case 'gt':
                    return (
                        typeof fieldValue === 'number' && fieldValue > (condition.value as number)
                    );
                case 'gte':
                    return (
                        typeof fieldValue === 'number' && fieldValue >= (condition.value as number)
                    );
                case 'lt':
                    return (
                        typeof fieldValue === 'number' && fieldValue < (condition.value as number)
                    );
                case 'lte':
                    return (
                        typeof fieldValue === 'number' && fieldValue <= (condition.value as number)
                    );
                case 'contains':
                    if (Array.isArray(fieldValue)) {
                        return fieldValue.includes(condition.value);
                    }
                    return String(fieldValue).includes(String(condition.value));
                case 'not_contains':
                    if (Array.isArray(fieldValue)) {
                        return !fieldValue.includes(condition.value);
                    }
                    return !String(fieldValue).includes(String(condition.value));
                case 'in':
                    return Array.isArray(condition.value) && condition.value.includes(fieldValue);
                default:
                    return true;
            }
        });
    }

    // Validation methods
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
