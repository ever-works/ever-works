import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import { ConfigService } from '../../config/config.service';
import { COMMAND } from '../../config';

interface SetCommandOptions {
    key?: string;
    value?: string;
}

@SubCommand({
    name: 'set',
    description: 'Set a configuration value',
    arguments: '<key> <value>',
})
export class SetSubCommand extends CommandRunner {
    private readonly logger = new Logger(SetSubCommand.name);

    constructor(private readonly configService: ConfigService) {
        super();
    }

    async run(passedParams: string[], options?: SetCommandOptions): Promise<void> {
        try {
            if (passedParams.length < 2) {
                console.log(chalk.red('✗ Error: Both key and value are required'));
                console.log(chalk.gray(`'Usage: ${COMMAND} config set <key> <value>'`));
                console.log(
                    chalk.gray(`Example: ${COMMAND} config set AI_DEFAULT_PROVIDER openai`),
                );
                return;
            }

            const [key, ...valueParts] = passedParams;
            const value = valueParts.join(' '); // Join in case value has spaces

            // Validate key format
            if (!this.isValidConfigKey(key)) {
                console.log(chalk.red(`✗ Invalid configuration key: ${key}`));
                console.log(
                    chalk.gray(
                        'Key must be uppercase with underscores (e.g., AI_DEFAULT_PROVIDER)',
                    ),
                );
                return;
            }

            // Load existing config
            const existingConfig = (await this.configService.loadConfig()) || {};

            // Validate value based on key
            const validationResult = this.validateKeyValue(key, value, existingConfig);
            if (!validationResult.isValid) {
                console.log(chalk.red(`✗ Invalid value for ${key}: ${validationResult.error}`));
                if (validationResult.suggestion) {
                    console.log(chalk.gray(`Suggestion: ${validationResult.suggestion}`));
                }
                return;
            }

            // Set the value
            const updatedConfig = { ...existingConfig, [key]: value };
            await this.configService.saveConfig(updatedConfig);

            console.log(
                chalk.green(`✓ Successfully set ${key} = ${this.maskSensitiveValue(key, value)}`),
            );

            // Show helpful information
            this.showKeyInfo(key);
        } catch (error) {
            this.logger.error('Failed to set configuration:', error);
            console.log(chalk.red('\n✗ Failed to set configuration:'), error.message);
        }
    }

    private isValidConfigKey(key: string): boolean {
        // Must be uppercase with underscores
        return /^[A-Z][A-Z0-9_]*$/.test(key);
    }

    private validateKeyValue(
        key: string,
        value: string,
        existingConfig: any,
    ): {
        isValid: boolean;
        error?: string;
        suggestion?: string;
    } {
        // AI Provider validation
        if (key === 'AI_DEFAULT_PROVIDER') {
            const validProviders = [
                'openai',
                'google',
                'anthropic',
                'openrouter',
                'ollama',
                'groq',
                'custom',
            ];
            if (!validProviders.includes(value.toLowerCase())) {
                return {
                    isValid: false,
                    error: 'Invalid AI provider',
                    suggestion: `Valid providers: ${validProviders.join(', ')}`,
                };
            }
        }

        // Service validation
        if (key === 'EXTRACT_CONTENT_SERVICE') {
            const validServices = ['tavily', 'local'];
            if (!validServices.includes(value.toLowerCase())) {
                return {
                    isValid: false,
                    error: 'Invalid content extraction service',
                    suggestion: `Valid services: ${validServices.join(', ')}`,
                };
            }
        }

        if (key === 'WEB_SEARCH_SERVICE') {
            const validServices = ['tavily'];
            if (!validServices.includes(value.toLowerCase())) {
                return {
                    isValid: false,
                    error: 'Invalid web search service',
                    suggestion: `Valid services: ${validServices.join(', ')}`,
                };
            }
        }

        // Temperature validation
        if (key.endsWith('_TEMPERATURE')) {
            const temp = parseFloat(value);
            if (isNaN(temp) || temp < 0 || temp > 2) {
                return {
                    isValid: false,
                    error: 'Temperature must be a number between 0.0 and 2.0',
                    suggestion: 'Example: 0.7',
                };
            }
        }

        // Max tokens validation
        if (key.endsWith('_MAX_TOKENS')) {
            const tokens = parseInt(value);
            if (isNaN(tokens) || tokens < 1 || tokens > 200000) {
                return {
                    isValid: false,
                    error: 'Max tokens must be a number between 1 and 200,000',
                    suggestion: 'Example: 4096',
                };
            }
        }

        // URL validation
        if (key.endsWith('_BASE_URL')) {
            try {
                new URL(value);
            } catch {
                return {
                    isValid: false,
                    error: 'Invalid URL format',
                    suggestion: 'Example: https://api.example.com',
                };
            }
        }

        // Email validation
        if (key === 'GIT_EMAIL') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(value)) {
                return {
                    isValid: false,
                    error: 'Invalid email format',
                    suggestion: 'Example: user@example.com',
                };
            }
        }

        return { isValid: true };
    }

    private maskSensitiveValue(key: string, value: string): string {
        const sensitiveKeys = ['API_KEY', 'TOKEN', 'APIKEY'];
        const isSensitive = sensitiveKeys.some((sensitive) => key.includes(sensitive));

        if (isSensitive && value.length > 8) {
            return (
                value.substring(0, 4) +
                '*'.repeat(value.length - 8) +
                value.substring(value.length - 4)
            );
        }

        return value;
    }

    private showKeyInfo(key: string): void {
        const keyInfo: Record<string, string> = {
            AI_DEFAULT_PROVIDER:
                'This sets your primary AI provider. Make sure the corresponding API key is configured.',
            GH_APIKEY: 'Used for GitHub API access. Get from: https://github.com/settings/tokens',
            VERCEL_TOKEN:
                'Used for Vercel deployments. Get from: https://vercel.com/account/tokens',
            TAVILY_API_KEY:
                'Used for enhanced search and content extraction. Get from: https://tavily.com',
        };

        if (keyInfo[key]) {
            console.log(chalk.blue('ℹ ') + chalk.gray(keyInfo[key]));
        }

        // Suggest testing after setting important keys
        const testableKeys = ['AI_DEFAULT_PROVIDER', 'GH_APIKEY', 'VERCEL_TOKEN', 'TAVILY_API_KEY'];
        if (testableKeys.includes(key)) {
            console.log(
                chalk.gray('Run ') +
                    chalk.cyan(`${COMMAND} config test`) +
                    chalk.gray(' to verify this setting.'),
            );
        }
    }
}
