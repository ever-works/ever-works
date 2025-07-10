import { Injectable } from '@nestjs/common';
import { BasePromptService } from './base-prompt.service';
import { AiProviderRegistryService } from '../ai-providers/ai-provider-registry.service';
import { AiProviderConfiguration, ConfiguredAiProvider, AiService } from '@packages/agent';
import ora from 'ora';

@Injectable()
export class AiProviderPromptService extends BasePromptService {
    constructor(
        private readonly aiProviderRegistry: AiProviderRegistryService,
        private readonly aiService: AiService
    ) {
        super();
    }

    async promptAiProviderConfiguration(): Promise<AiProviderConfiguration> {
        this.displaySectionHeader('AI Provider Configuration');
        this.displayInfo('Configure your AI providers for the agent to work properly');

        // Select default provider
        const defaultProvider = await this.promptSelect(
            'Select your default AI provider:',
            this.aiProviderRegistry.getProviderChoicesWithIgnore()
        );

        if (defaultProvider === 'ignore') {
            this.displayWarning('AI configuration skipped. The agent will not work without AI providers.');
            return {
                defaultProvider: '',
                fallbackProviders: [],
                providers: [],
            };
        }

        const configuredProviders: ConfiguredAiProvider[] = [];

        // Configure the default provider
        const defaultProviderConfig = await this.configureProvider(defaultProvider, true);
        if (defaultProviderConfig) {
            configuredProviders.push(defaultProviderConfig);
        }

        // Ask for fallback providers
        const wantsFallback = await this.promptConfirm(
            'Do you want to configure fallback AI providers? (Recommended for reliability)'
        );

        let fallbackProviders: string[] = [];

        if (wantsFallback) {
            const availableForFallback = this.aiProviderRegistry
                .getProviderChoices()
                .filter(choice => choice.value !== defaultProvider);

            if (availableForFallback.length > 0) {
                fallbackProviders = await this.promptMultiSelect(
                    'Select fallback providers (in order of preference):',
                    availableForFallback.map(choice => ({
                        name: choice.name,
                        value: choice.value,
                    }))
                );

                // Configure each fallback provider
                for (const providerName of fallbackProviders) {
                    const providerConfig = await this.configureProvider(providerName, false);
                    if (providerConfig) {
                        configuredProviders.push(providerConfig);
                    }
                }
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
        isDefault: boolean
    ): Promise<ConfiguredAiProvider | null> {
        const providerInfo = this.aiProviderRegistry.getProvider(providerName);
        if (!providerInfo) {
            this.displayError(`Unknown provider: ${providerName}`);
            return null;
        }

        this.displaySectionHeader(
            `Configure ${providerInfo.displayName}${isDefault ? ' (Default Provider)' : ''}`
        );

        this.displayInfo(`Website: ${providerInfo.websiteUrl}`);
        this.displayInfo(`Documentation: ${providerInfo.docsUrl}`);

        let apiKey = '';
        if (providerInfo.requiresApiKey) {
            while (true) {
                try {
                    apiKey = await this.promptPassword(
                        `Enter your ${providerInfo.displayName} API key:`
                    );

                    const validation = this.validateApiKey(apiKey, providerInfo.displayName);
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

        // Model selection
        const model = await this.promptSelect(
            'Select a model:',
            providerInfo.models.map((modelName: string) => ({
                name: modelName,
                value: modelName,
            }))
        );

        // Advanced configuration
        const wantsAdvanced = await this.promptConfirm(
            'Do you want to configure advanced settings? (temperature, max tokens, etc.)',
            false
        );

        let temperature = providerInfo.defaults.temperature;
        let maxTokens = providerInfo.defaults.maxTokens;
        let baseUrl = providerInfo.defaults.baseUrl;

        if (wantsAdvanced) {
            // Temperature validation with retry
            while (true) {
                try {
                    temperature = await this.promptNumber(
                        'Enter temperature (0.0 = deterministic, 1.0 = creative):',
                        providerInfo.defaults.temperature,
                        0,
                        2
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

            // Max tokens validation with retry
            while (true) {
                try {
                    const tokensInput = await this.promptNumber(
                        'Enter max tokens:',
                        providerInfo.defaults.maxTokens,
                        1,
                        100000
                    );

                    // Convert to integer for max tokens
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

            // Base URL validation with retry
            if (providerInfo.defaults.baseUrl) {
                while (true) {
                    try {
                        const customBaseUrl = await this.promptOptionalText(
                            'Enter custom base URL (leave empty for default):',
                            providerInfo.defaults.baseUrl
                        );

                        if (customBaseUrl) {
                            const urlValidation = this.validateUrl(customBaseUrl);
                            if (urlValidation !== true) {
                                this.displayError(urlValidation as string);
                                continue;
                            }
                            baseUrl = customBaseUrl;
                        } else {
                            baseUrl = providerInfo.defaults.baseUrl;
                        }
                        break;
                    } catch (error) {
                        this.displayError('Invalid URL format. Please try again.');
                    }
                }
            }
        }

        // Test the provider configuration
        const shouldTest = await this.promptConfirm(
            `Do you want to test the ${providerInfo.displayName} configuration now?`,
            true
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
                this.displaySuccess(`${providerInfo.displayName} test passed! Response time: ${testResult.responseTime}ms`);
                this.displayInfo(`Response: ${testResult.response}`);
            } else {
                this.displayError(`${providerInfo.displayName} test failed: ${testResult.error}`);

                const options = await this.promptSelect(
                    'What would you like to do?',
                    [
                        { name: 'Continue with this configuration anyway', value: 'continue' },
                        { name: 'Re-enter the API key', value: 'retry' },
                        { name: 'Skip this provider', value: 'skip' },
                    ]
                );

                if (options === 'skip') {
                    this.displayInfo('Provider configuration skipped');
                    return null;
                } else if (options === 'retry') {
                    this.displayInfo('Please re-enter your configuration');
                    return this.configureProvider(providerName, isDefault);
                }
                // If 'continue', we proceed with the current configuration
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

    /**
     * Test a provider configuration using the AI service
     */
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
}
