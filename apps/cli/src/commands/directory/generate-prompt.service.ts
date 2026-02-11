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
import type { FormFieldCondition } from '@ever-works/contracts';
import { getIndividualProviderCategories, type IndividualCategoryKey } from '@ever-works/plugin';

export interface CompanyDto {
    name: string;
    website: string;
}

export interface ProviderSelectionResult {
    providers: Partial<ProvidersDto>;
    pipelineId: string | null;
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
     * Prompts for provider selection based on the generator form schema
     */
    async promptProviderSelection(schema: GeneratorFormSchema): Promise<ProviderSelectionResult> {
        this.displaySectionHeader('Provider Selection');

        const providers: Partial<ProvidersDto> = {};
        let pipelineId: string | null = null;

        // Check if full pipeline providers are available
        const configuredPipelines =
            schema.providers.fullPipeline?.filter((p) => p.configured) || [];

        if (configuredPipelines.length > 0) {
            const mode = await this.promptSelect(
                'Generation mode:',
                [
                    {
                        name: 'Standard (select individual providers)',
                        value: 'standard' as const,
                    },
                    {
                        name: 'Full Pipeline (use a preconfigured pipeline)',
                        value: 'pipeline' as const,
                    },
                ],
                'standard' as const,
            );

            if (mode === 'pipeline') {
                const choices = configuredPipelines.map((p) => ({
                    name: `${p.name}${p.isDefault ? ' (default)' : ''}${p.description ? ` - ${p.description}` : ''}`,
                    value: p.id,
                }));

                const selectedPipeline = await this.promptSelect(
                    'Select pipeline:',
                    choices,
                    configuredPipelines.find((p) => p.isDefault)?.id || configuredPipelines[0].id,
                );

                providers.pipeline = selectedPipeline;
                pipelineId = selectedPipeline;

                return { providers, pipelineId };
            }
        }

        // Standard mode: prompt for each provider category with >1 option
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

            const configured = category.options.filter((p) => p.configured);
            if (configured.length <= 1) continue;

            const choices: Array<{ name: string; value: string }> = [
                { name: 'Auto (default)', value: '' },
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

            let selected = await this.promptSelect(`${category.label}:`, choices, '');

            // Re-prompt if user selected a disabled provider
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
     * Prompts for dynamic plugin form fields
     */
    async promptDynamicFields(
        fields: FormFieldDefinition[],
        groups?: FormFieldGroup[],
        defaults?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        if (!fields || fields.length === 0) return {};

        const values: Record<string, unknown> = { ...defaults };

        // Sort fields by group and order
        const sortedGroups = [...(groups || [])].sort(
            (a, b) => (a.order ?? 999) - (b.order ?? 999),
        );

        // Get ungrouped fields first
        const ungroupedFields = fields
            .filter((f) => !f.group)
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

        // Prompt ungrouped fields
        for (const field of ungroupedFields) {
            await this.promptField(field, values, defaults);
        }

        // Prompt grouped fields
        for (const group of sortedGroups) {
            const groupFields = fields
                .filter((f) => f.group === group.name)
                .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

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
                console.log(chalk.cyan(`\n--- ${group.title} ---`));
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

        if (dto.repository_description) {
            console.log(
                chalk.gray('Repository Description:'),
                chalk.white(dto.repository_description),
            );
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
            chalk.white(dto.update_with_pull_request !== false ? 'Yes' : 'No'),
        );
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

            switch (condition.operator) {
                case 'eq':
                    return fieldValue === condition.value;
                case 'neq':
                    return fieldValue !== condition.value;
                case 'gt':
                    return Number(fieldValue) > Number(condition.value);
                case 'gte':
                    return Number(fieldValue) >= Number(condition.value);
                case 'lt':
                    return Number(fieldValue) < Number(condition.value);
                case 'lte':
                    return Number(fieldValue) <= Number(condition.value);
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
                default:
                    return true;
            }
        });
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
