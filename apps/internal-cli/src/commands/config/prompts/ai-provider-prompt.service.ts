import { Injectable } from '@nestjs/common';
import { AiProviderRegistryService } from '../ai-providers/ai-provider-registry.service';
import { AiProviderConfiguration, ConfiguredAiProvider, AiService } from '@packages/agent/ai';
import ora from 'ora';
import { BasePromptService } from '@packages/cli-shared';

@Injectable()
export class AiProviderPromptService extends BasePromptService {
    constructor(
        private readonly aiProviderRegistry: AiProviderRegistryService,
        private readonly aiService: AiService,
    ) {
        super();
    }

    async promptAiProviderConfiguration(existingConfig?: any): Promise<AiProviderConfiguration> {
        this.displaySectionHeader('AI Provider Configuration');
        this.displayInfo('Configure your AI providers for the agent to work properly');

        const defaultProvider = await this.promptSelect(
            'Select your default AI provider:',
            this.aiProviderRegistry.getProviderChoicesWithIgnore(),
            existingConfig?.AI_DEFAULT_PROVIDER,
        );

        if (defaultProvider === 'ignore') {
            this.displayWarning(
                'AI configuration skipped. The agent will not work without AI providers.',
            );
            return {
                defaultProvider: '',
                fallbackProviders: [],
                providers: [],
            };
        }

        const configuredProviders: ConfiguredAiProvider[] = [];

        const defaultProviderConfig = await this.configureProvider(
            defaultProvider,
            true,
            existingConfig,
        );
        if (defaultProviderConfig) {
            configuredProviders.push(defaultProviderConfig);
        }

        const wantsFallback = await this.promptConfirm(
            'Do you want to configure fallback AI providers? (Recommended for reliability)',
        );

        let fallbackProviders: string[] = [];

        if (wantsFallback) {
            const availableForFallback = this.aiProviderRegistry
                .getProviderChoices()
                .filter((choice) => choice.value !== defaultProvider);

            if (availableForFallback.length > 0) {
                while (true) {
                    const remainingProviders = availableForFallback.filter(
                        (choice) => !fallbackProviders.includes(choice.value),
                    );

                    if (remainingProviders.length === 0) {
                        this.displayInfo('All available providers have been configured');
                        break;
                    }

                    const choices = [
                        ...remainingProviders.map((choice) => ({
                            name: `Configure ${choice.name}`,
                            value: choice.value,
                        })),
                        { name: 'Finish configuring fallback providers', value: '__done__' },
                    ];

                    const selectedProvider = await this.promptSelect(
                        fallbackProviders.length === 0
                            ? 'Select a fallback provider to configure:'
                            : `Select another fallback provider (${fallbackProviders.length} already configured):`,
                        choices,
                    );

                    if (selectedProvider === '__done__') {
                        break;
                    }

                    this.displayInfo(`\nConfiguring fallback provider: ${selectedProvider}`);
                    const providerConfig = await this.configureProvider(
                        selectedProvider,
                        false,
                        existingConfig,
                    );

                    if (providerConfig) {
                        configuredProviders.push(providerConfig);
                        fallbackProviders.push(selectedProvider);
                        this.displaySuccess(
                            `${selectedProvider} configured as fallback provider #${fallbackProviders.length}`,
                        );
                    } else {
                        this.displayWarning(`Skipped configuring ${selectedProvider}`);
                    }

                    if (remainingProviders.length > 1) {
                        const continueAdding = await this.promptConfirm(
                            'Do you want to configure another fallback provider?',
                            false,
                        );
                        if (!continueAdding) {
                            break;
                        }
                    }
                }

                if (fallbackProviders.length > 0) {
                    this.displaySuccess(
                        `Configured ${fallbackProviders.length} fallback provider(s): ${fallbackProviders.join(', ')}`,
                    );
                } else {
                    this.displayInfo('No fallback providers configured');
                }
            } else {
                this.displayWarning('No other providers available for fallback configuration');
            }
        }

        this.displaySuccess('AI provider configuration completed');

        return {
            defaultProvider,
            fallbackProviders,
            providers: configuredProviders,
        };
    }

    private async configureProvider(
        providerName: string,
        isDefault: boolean,
        existingConfig?: any,
    ): Promise<ConfiguredAiProvider | null> {
        const providerInfo = this.aiProviderRegistry.getProvider(providerName);
        if (!providerInfo) {
            this.displayError(`Unknown provider: ${providerName}`);
            return null;
        }

        this.displaySectionHeader(
            `Configure ${providerInfo.displayName}${isDefault ? ' (Default Provider)' : ''}`,
        );

        this.displayInfo(`Website: ${providerInfo.websiteUrl}`);
        this.displayInfo(`Documentation: ${providerInfo.docsUrl}`);

        const upperProvider = providerName.toUpperCase();
        const existingApiKey = existingConfig?.[`${upperProvider}_API_KEY`];
        const existingModel = existingConfig?.[`${upperProvider}_MODEL`];
        const existingTemperature = existingConfig?.[`${upperProvider}_TEMPERATURE`];
        const existingMaxTokens = existingConfig?.[`${upperProvider}_MAX_TOKENS`];
        const existingBaseUrl = existingConfig?.[`${upperProvider}_BASE_URL`];

        if (existingApiKey) {
            this.displayInfo(`Found existing configuration for ${providerInfo.displayName}`);
        }

        let apiKey = '';
        let baseUrl = existingBaseUrl || providerInfo.defaults.baseUrl;

        if (providerName === 'custom') {
            this.displayInfo('Custom provider requires an OpenAI-compatible API endpoint.');
            while (true) {
                try {
                    const inputBaseUrl = await this.promptRequiredText(
                        `Enter the base URL for your API endpoint:${existingBaseUrl ? ' (leave empty to keep current)' : ''}`,
                        existingBaseUrl,
                    );

                    if (!inputBaseUrl && existingBaseUrl) {
                        baseUrl = existingBaseUrl;
                        this.displayInfo('Using existing base URL');
                        break;
                    }

                    const urlValidation = this.validateUrl(inputBaseUrl);
                    if (urlValidation !== true) {
                        this.displayError(urlValidation as string);
                        continue;
                    }
                    baseUrl = inputBaseUrl;
                    break;
                } catch (error) {
                    this.displayError('Invalid URL format. Please try again.');
                }
            }

            const wantsApiKey = await this.promptConfirm(
                'Does your endpoint require an API key?',
                true,
            );

            if (wantsApiKey) {
                apiKey = await this.promptPasswordRequired(
                    `Enter your API key:${existingApiKey ? ' (leave empty to keep current)' : ''}`,
                    !existingApiKey,
                );
                if (!apiKey && existingApiKey) {
                    apiKey = existingApiKey;
                    this.displayInfo('Using existing API key');
                }
            }
        } else if (providerInfo.requiresApiKey) {
            while (true) {
                try {
                    apiKey = await this.promptPasswordRequired(
                        `Enter your ${providerInfo.displayName} API key:${existingApiKey ? ' (leave empty to keep current)' : ''}`,
                        !existingApiKey,
                    );

                    if (!apiKey && existingApiKey) {
                        apiKey = existingApiKey;
                        this.displayInfo('Using existing API key');
                        break;
                    }

                    const validation = this.validateApiKeyWithProvider(
                        apiKey,
                        providerInfo.displayName,
                    );
                    if (validation !== true) {
                        this.displayError(validation as string);
                        continue;
                    }

                    break;
                } catch (error) {
                    this.displayError('Failed to get API key. Please try again.');
                }
            }
        }

        let model: string;

        if (providerName === 'custom' || providerInfo.models.length === 0) {
            this.displayInfo(this.getCustomModelExamples(providerName));

            while (true) {
                try {
                    model = await this.promptRequiredText(
                        `Enter model name:`,
                        existingModel || providerInfo.defaults.model,
                        this.validateModelName.bind(this),
                    );
                    break;
                } catch (error) {
                    this.displayError('Invalid model name. Please try again.');
                }
            }
        } else {
            const modelChoices = [
                ...providerInfo.models.map((modelName: string) => ({
                    name: modelName,
                    value: modelName,
                })),
                { name: 'Enter custom model name', value: '__custom__' },
            ];

            let defaultModel = existingModel || providerInfo.defaults.model;

            const selectedModel = await this.promptSelect(
                'Select a model:',
                modelChoices,
                defaultModel,
            );

            if (selectedModel === '__custom__') {
                this.displayInfo(this.getCustomModelExamples(providerName));

                while (true) {
                    try {
                        model = await this.promptRequiredText(
                            `Enter custom model name for ${providerInfo.displayName}:`,
                            existingModel,
                            this.validateModelName.bind(this),
                        );
                        break;
                    } catch (error) {
                        this.displayError('Invalid model name. Please try again.');
                    }
                }
                this.displayInfo(`Using custom model: ${model}`);
            } else {
                model = selectedModel;
            }
        }

        const wantsAdvanced = await this.promptConfirm(
            'Do you want to configure advanced settings? (temperature, max tokens, etc.)',
            false,
        );

        let temperature = existingTemperature
            ? parseFloat(existingTemperature)
            : providerInfo.defaults.temperature;

        let maxTokens = existingMaxTokens
            ? parseInt(existingMaxTokens)
            : providerInfo.defaults.maxTokens;

        if (wantsAdvanced) {
            while (true) {
                try {
                    temperature = await this.promptNumberMinMax(
                        'Enter temperature (0.0 = deterministic, 1.0 = creative):',
                        temperature,
                        0,
                        2,
                    );

                    const tempValidation = this.validateTemperature(temperature);
                    if (tempValidation !== true) {
                        this.displayError(tempValidation as string);
                        continue;
                    }
                    break;
                } catch (error) {
                    this.displayError('Invalid temperature value. Please try again.');
                }
            }

            while (true) {
                try {
                    const tokensInput = await this.promptNumberMinMax(
                        'Enter max tokens:',
                        maxTokens,
                        1,
                        100000,
                    );

                    maxTokens = Math.round(tokensInput);

                    const tokensValidation = this.validateMaxTokens(maxTokens);
                    if (tokensValidation !== true) {
                        this.displayError(tokensValidation as string);
                        continue;
                    }
                    break;
                } catch (error) {
                    this.displayError('Invalid max tokens value. Please try again.');
                }
            }

            if (providerInfo.defaults.baseUrl && providerName !== 'custom') {
                while (true) {
                    try {
                        const customBaseUrl = await this.promptOptionalText(
                            'Enter custom base URL (leave empty for default):',
                            baseUrl,
                        );

                        if (customBaseUrl) {
                            const urlValidation = this.validateUrl(customBaseUrl);
                            if (urlValidation !== true) {
                                this.displayError(urlValidation as string);
                                continue;
                            }
                            baseUrl = customBaseUrl;
                        } else {
                            baseUrl = baseUrl || providerInfo.defaults.baseUrl;
                        }
                        break;
                    } catch (error) {
                        this.displayError('Invalid URL format. Please try again.');
                    }
                }
            }
        }

        const shouldTest = await this.promptConfirm(
            `Do you want to test the ${providerInfo.displayName} configuration now?`,
            true,
        );

        if (shouldTest) {
            const testResult = await this.testProviderConfiguration({
                name: providerName,
                apiKey,
                model,
                temperature,
                maxTokens,
                baseUrl,
            });

            if (testResult.success) {
                this.displaySuccess(
                    `${providerInfo.displayName} test passed! Response time: ${testResult.responseTime}ms`,
                );
                this.displayInfo(`Response: ${testResult.response}`);
            } else {
                this.displayError(`${providerInfo.displayName} test failed: ${testResult.error}`);

                const options = await this.promptSelect('What would you like to do?', [
                    { name: 'Continue with this configuration anyway', value: 'continue' },
                    { name: 'Re-enter the API key', value: 'retry' },
                    { name: 'Skip this provider', value: 'skip' },
                ]);

                if (options === 'skip') {
                    this.displayInfo('Provider configuration skipped');
                    return null;
                } else if (options === 'retry') {
                    this.displayInfo('Please re-enter your configuration');
                    return this.configureProvider(providerName, isDefault, existingConfig);
                }
            }
        }

        this.displaySuccess(`${providerInfo.displayName} configured successfully`);

        return {
            name: providerName,
            apiKey,
            model,
            temperature,
            maxTokens,
            baseUrl,
        };
    }

    private async testProviderConfiguration(config: ConfiguredAiProvider): Promise<{
        success: boolean;
        provider: string;
        model: string;
        responseTime: number;
        error?: string;
        response?: string;
    }> {
        const spinner = ora(`Testing ${config.name} provider...`).start();

        try {
            const result = await this.aiService.testProvider({
                type: config.name as any,
                apiKey: config.apiKey,
                modelName: config.model,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                baseURL: config.baseUrl,
            });

            if (result.success) {
                spinner.succeed(`${config.name} test completed`);
            } else {
                spinner.fail(`${config.name} test failed`);
            }

            return result;
        } catch (error) {
            spinner.fail(`${config.name} test failed`);
            return {
                success: false,
                provider: config.name,
                model: config.model,
                responseTime: 0,
                error: error.message,
            };
        }
    }

    private getCustomModelExamples(providerName: string): string {
        const examples: Record<string, string> = {
            openai: 'Examples: gpt-5.2, gpt-5.1, gpt-5, gpt-5-mini, gpt-5-nano, gpt-4o, gpt-4o-mini, o3-mini',
            google: 'Examples: gemini-3-pro, gemini-3-flash, gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash',
            anthropic:
                'Examples: claude-opus-4-5-20251101, claude-sonnet-4.5, claude-haiku-4.5, claude-3-5-sonnet-latest',
            openrouter:
                'Examples: openai/gpt-5.2, openai/gpt-5-mini, anthropic/claude-opus-4.5, google/gemini-3-flash, meta-llama/llama-3.3-70b-instruct:free',
            ollama: 'Examples: llama3.3, llama3.2, qwen2.5, qwen2.5-coder, deepseek-r1, gemma2, phi4',
            groq: 'Examples: openai/gpt-oss-120b, llama-3.3-70b-versatile, llama-3.1-8b-instant, qwen-qwq-32b',
            custom: 'Enter any model name supported by your OpenAI-compatible endpoint',
        };

        return examples[providerName] || 'Enter the exact model name as specified by the provider';
    }
}
