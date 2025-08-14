import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigService } from '../../config/config.service';
import { AiService } from '@packages/agent/ai';
import { COMMAND } from '../../config';

@SubCommand({
    name: 'test',
    description: 'Test configuration connectivity',
})
export class TestSubCommand extends CommandRunner {
    private readonly logger = new Logger(TestSubCommand.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly aiService: AiService,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            const config = await this.configService.loadConfig();

            if (!config) {
                console.log(chalk.yellow('⚠ No configuration found.'));
                console.log(
                    chalk.gray('Run ') +
                        chalk.cyan(`${COMMAND} config setup`) +
                        chalk.gray(' to create a configuration.'),
                );
                return;
            }

            let allTestsPassed = true;

            // Test AI providers
            const aiTestResults = await this.testAiProviders(config);
            if (!aiTestResults) {
                allTestsPassed = false;
            }

            // Test other services (GitHub, Vercel, etc.)
            const serviceTestResults = await this.testOtherServices(config);
            if (!serviceTestResults) {
                allTestsPassed = false;
            }

            // Display final results
            console.log('\n' + chalk.cyan.bold('Test Summary'));
            if (allTestsPassed) {
                console.log(
                    chalk.green('✓ All tests passed! Your configuration is working correctly.'),
                );
            } else {
                console.log(
                    chalk.yellow(
                        '⚠ Some tests failed. Please check the configuration and try again.',
                    ),
                );
            }
        } catch (error) {
            this.logger.error('Configuration test failed:', error);
            console.log(chalk.red('\n✗ Configuration test failed:'), error.message);
        }
    }

    private async testAiProviders(config: any): Promise<boolean> {
        console.log(chalk.blue.bold('Testing AI Providers\n'));

        const providers = this.getConfiguredAiProviders(config);
        if (providers.length === 0) {
            console.log(chalk.yellow('⚠ No AI providers configured'));
            return false;
        }

        let allPassed = true;

        for (const provider of providers) {
            const spinner = ora(`Testing ${provider} provider...`).start();

            try {
                const result = await this.aiService.testProvider({
                    type: provider as any,
                    apiKey: config[`${provider.toUpperCase()}_API_KEY`],
                    modelName:
                        config[`${provider.toUpperCase()}_MODEL`] || this.getDefaultModel(provider),
                    temperature: parseFloat(
                        config[`${provider.toUpperCase()}_TEMPERATURE`] || '0.7',
                    ),
                    maxTokens: parseInt(config[`${provider.toUpperCase()}_MAX_TOKENS`] || '4096'),
                    baseURL: config[`${provider.toUpperCase()}_BASE_URL`],
                });

                if (result.success) {
                    spinner.succeed(
                        `${provider}: ${chalk.green('✓ Connected')} (${result.responseTime}ms)`,
                    );
                    console.log(chalk.gray(`  Response: ${result.response}`));
                } else {
                    spinner.fail(`${provider}: ${chalk.red('✗ Failed')}`);
                    console.log(chalk.red(`  Error: ${result.error}`));
                    allPassed = false;
                }
            } catch (error) {
                spinner.fail(`${provider}: ${chalk.red('✗ Failed')}`);
                console.log(chalk.red(`  Error: ${error.message}`));
                allPassed = false;
            }
        }

        return allPassed;
    }

    private async testOtherServices(config: any): Promise<boolean> {
        console.log(chalk.blue.bold('\nTesting Other Services\n'));

        let allPassed = true;

        // Test GitHub API
        if (config.GITHUB_APIKEY) {
            const githubResult = await this.testGitHubApi(config.GITHUB_APIKEY);
            if (!githubResult) {
                allPassed = false;
            }
        }

        // Test Vercel API
        if (config.VERCEL_TOKEN) {
            const vercelResult = await this.testVercelApi(config.VERCEL_TOKEN);
            if (!vercelResult) {
                allPassed = false;
            }
        }

        // Test Tavily API
        if (config.TAVILY_API_KEY) {
            const tavilyResult = await this.testTavilyApi(config.TAVILY_API_KEY);
            if (!tavilyResult) {
                allPassed = false;
            }
        }

        return allPassed;
    }

    private async testGitHubApi(apiKey: string): Promise<boolean> {
        const spinner = ora('Testing GitHub API...').start();

        try {
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    Authorization: `token ${apiKey}`,
                    'User-Agent': 'ever-works-cli',
                },
            });

            if (response.ok) {
                const user = await response.json();
                spinner.succeed(`GitHub API: ${chalk.green('✓ Connected')} (User: ${user.login})`);
                return true;
            } else {
                spinner.fail(`GitHub API: ${chalk.red('✗ Failed')} (Status: ${response.status})`);
                return false;
            }
        } catch (error) {
            spinner.fail(`GitHub API: ${chalk.red('✗ Failed')}`);
            console.log(chalk.red(`  Error: ${error.message}`));
            return false;
        }
    }

    private async testVercelApi(token: string): Promise<boolean> {
        const spinner = ora('Testing Vercel API...').start();

        try {
            const response = await fetch('https://api.vercel.com/v2/user', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (response.ok) {
                const user = await response.json();
                spinner.succeed(
                    `Vercel API: ${chalk.green('✓ Connected')} (User: ${user.user.username})`,
                );
                return true;
            } else {
                spinner.fail(`Vercel API: ${chalk.red('✗ Failed')} (Status: ${response.status})`);
                return false;
            }
        } catch (error) {
            spinner.fail(`Vercel API: ${chalk.red('✗ Failed')}`);
            console.log(chalk.red(`  Error: ${error.message}`));
            return false;
        }
    }

    private async testTavilyApi(apiKey: string): Promise<boolean> {
        const spinner = ora('Testing Tavily API...').start();

        try {
            const response = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    api_key: apiKey,
                    query: 'test',
                    max_results: 1,
                }),
            });

            if (response.ok) {
                spinner.succeed(`Tavily API: ${chalk.green('✓ Connected')}`);
                return true;
            } else {
                spinner.fail(`Tavily API: ${chalk.red('✗ Failed')} (Status: ${response.status})`);
                return false;
            }
        } catch (error) {
            spinner.fail(`Tavily API: ${chalk.red('✗ Failed')}`);
            console.log(chalk.red(`  Error: ${error.message}`));
            return false;
        }
    }

    private getConfiguredAiProviders(config: any): string[] {
        const providers: string[] = [];
        const providerKeys = [
            'openai',
            'google',
            'anthropic',
            'openrouter',
            'ollama',
            'mistral',
            'deepseek',
            'groq',
        ];

        for (const provider of providerKeys) {
            const upperProvider = provider.toUpperCase();
            if (
                config[`${upperProvider}_API_KEY`] ||
                (provider === 'ollama' && config[`${upperProvider}_BASE_URL`])
            ) {
                providers.push(provider);
            }
        }

        return providers;
    }

    private getDefaultModel(provider: string): string {
        const defaults: Record<string, string> = {
            openai: 'gpt-4.1',
            google: 'gemini-2.5-flash',
            anthropic: 'claude-3-5-sonnet-20241022',
            openrouter: 'openai/gpt-4.1',
            ollama: 'llama2',
            mistral: 'mistral-large-latest',
            deepseek: 'deepseek-chat',
            groq: 'llama-3.1-70b-versatile',
        };
        return defaults[provider] || 'default';
    }
}
