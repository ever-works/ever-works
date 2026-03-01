import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { BasePromptService } from '@ever-works/cli-shared';
import type {
    PluginSettingsSchema,
    PluginSettingsSchemaProperty,
    SettingScopeApi,
} from '@ever-works/plugin/api';
import {
    getVisibleProperties,
    validateRequiredSettings,
    sanitizeSettingsForSave,
    validateSettingsConstraints,
} from '@ever-works/plugin/api';
import type { AiModel } from '@ever-works/plugin';
import { getApiService } from '../../services/api.service';

interface PromptSettingsOptions {
    pluginId: string;
    schema: PluginSettingsSchema;
    currentSettings?: Record<string, unknown>;
    currentSecretSettings?: Record<string, unknown>;
    scope: 'user' | 'directory';
    scopes: SettingScopeApi[];
    fallbackSettings?: Record<string, unknown>;
}

interface PromptSettingsResult {
    settings: Record<string, unknown>;
    secretSettings: Record<string, unknown>;
}

export class PluginSettingsPromptService extends BasePromptService {
    private modelCache = new Map<string, readonly AiModel[]>();

    async promptSettings(options: PromptSettingsOptions): Promise<PromptSettingsResult | null> {
        const {
            pluginId,
            schema,
            currentSettings = {},
            currentSecretSettings = {},
            scope,
            scopes,
            fallbackSettings,
        } = options;
        const visibleProps = getVisibleProperties(schema, scopes);

        if (Object.keys(visibleProps).length === 0) {
            this.displayInfo('This plugin has no configurable settings for the current scope.');
            return null;
        }

        const settings: Record<string, unknown> = { ...currentSettings };
        const secretSettings: Record<string, unknown> = { ...currentSecretSettings };

        for (const [key, prop] of Object.entries(visibleProps)) {
            // Evaluate showIf conditions
            if (prop.showIf) {
                const refValue = settings[prop.showIf.field] ?? secretSettings[prop.showIf.field];
                if (refValue !== prop.showIf.value) continue;
            }

            const currentValue = prop.secret
                ? (currentSecretSettings[key] ?? currentSettings[key])
                : currentSettings[key];
            const inheritedValue = fallbackSettings?.[key];
            const displayDefault = currentValue ?? inheritedValue ?? prop.default;

            const label = this.buildLabel(key, prop, scope, inheritedValue);
            const value = await this.promptField(pluginId, prop, label, displayDefault);

            if (prop.secret) {
                secretSettings[key] = value;
            } else {
                settings[key] = value;
            }
        }

        // Validate
        const missingFields = validateRequiredSettings(
            settings,
            secretSettings,
            schema,
            scopes,
            scope,
            fallbackSettings,
        );
        if (missingFields.length > 0) {
            this.displayError(`Missing required fields: ${missingFields.join(', ')}`);
            const retry = await this.promptConfirm('Would you like to re-enter settings?', true);
            if (retry) {
                return this.promptSettings({
                    ...options,
                    currentSettings: settings,
                    currentSecretSettings: secretSettings,
                });
            }
            return null;
        }

        const constraintErrors = validateSettingsConstraints(
            { ...settings, ...secretSettings },
            visibleProps,
        );
        if (constraintErrors.length > 0) {
            this.displayError(
                `Validation errors: ${constraintErrors.map((e) => e.message).join(', ')}`,
            );
            const retry = await this.promptConfirm('Would you like to re-enter settings?', true);
            if (retry) {
                return this.promptSettings({
                    ...options,
                    currentSettings: settings,
                    currentSecretSettings: secretSettings,
                });
            }
            return null;
        }

        return {
            settings: sanitizeSettingsForSave(settings, scope),
            secretSettings: sanitizeSettingsForSave(secretSettings, scope),
        };
    }

    private buildLabel(
        key: string,
        prop: PluginSettingsSchemaProperty,
        scope: 'user' | 'directory',
        inheritedValue: unknown,
    ): string {
        let label = prop.title || key;
        if (prop.description) {
            label += chalk.gray(` — ${prop.description}`);
        }
        if (scope === 'directory' && inheritedValue !== undefined && inheritedValue !== null) {
            const preview =
                typeof inheritedValue === 'string' && prop.secret ? '••••' : String(inheritedValue);
            label += chalk.blue(` [inherited: ${preview}]`);
        }
        return label;
    }

    private async promptField(
        pluginId: string,
        prop: PluginSettingsSchemaProperty,
        label: string,
        defaultValue: unknown,
    ): Promise<unknown> {
        if (prop.secret) {
            return this.promptPasswordRequired(label, false);
        }

        // Model-select widget: fetch models from API and present as select
        if (prop.widget === 'model-select') {
            return this.promptModelSelect(pluginId, label, defaultValue as string | undefined);
        }

        if (prop.enum && prop.enum.length > 0) {
            const choices = prop.enum.map((v) => ({
                name: String(v),
                value: String(v),
            }));
            return this.promptSelect(label, choices, defaultValue as string | undefined);
        }

        if (prop.type === 'boolean') {
            return this.promptConfirm(label, (defaultValue as boolean) ?? false);
        }

        if (prop.type === 'number') {
            return this.promptNumberMinMax(
                label,
                defaultValue as number | undefined,
                prop.minimum,
                prop.maximum,
            );
        }

        // Default: string
        return this.promptOptionalText(label, defaultValue as string | undefined);
    }

    private async promptModelSelect(
        pluginId: string,
        label: string,
        defaultValue: string | undefined,
    ): Promise<string | undefined> {
        const models = await this.fetchModels(pluginId);

        if (models.length === 0) {
            // Fallback to text input if models can't be fetched
            this.displayWarning('Could not fetch available models. Enter model ID manually.');
            return this.promptOptionalText(label, defaultValue);
        }

        const choices: { name: string; value: string }[] = models.map((m) => {
            const ctx = m.capabilities?.maxContextLength
                ? chalk.gray(` (${formatContext(m.capabilities.maxContextLength)})`)
                : '';
            return {
                name: `${m.name || m.id}${ctx}`,
                value: m.id,
            };
        });

        choices.push(new inquirer.Separator('') as any);
        choices.push({ name: chalk.blue('Enter custom model ID'), value: '__custom__' });

        const { model } = await inquirer.prompt([
            {
                type: 'list',
                name: 'model',
                message: label,
                choices,
                default: defaultValue,
                pageSize: 15,
            },
        ]);

        if (model === '__custom__') {
            return this.promptOptionalText(`${label} (custom model ID)`, defaultValue);
        }

        return model;
    }

    private async fetchModels(pluginId: string): Promise<readonly AiModel[]> {
        if (this.modelCache.has(pluginId)) {
            return this.modelCache.get(pluginId)!;
        }

        const spinner = ora('Fetching available models...').start();
        try {
            const apiService = getApiService();
            const models = await apiService.listPluginModels(pluginId);
            this.modelCache.set(pluginId, models);
            spinner.stop();
            return models;
        } catch {
            spinner.stop();
            return [];
        }
    }
}

function formatContext(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
    return `${tokens} ctx`;
}
