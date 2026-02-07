import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigService } from '../../config/config.service';
import { AiFacadeService, GitFacadeService } from '@ever-works/agent/facades';

import { COMMAND } from '../../config';

@SubCommand({
    name: 'test',
    description: 'Test configuration connectivity',
})
export class TestSubCommand extends CommandRunner {
    private readonly logger = new Logger(TestSubCommand.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly aiFacade: AiFacadeService,
        private readonly gitFacade: GitFacadeService,
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

            // Test other services (Git, Deployment, etc.)
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

    private async testAiProviders(_config: any): Promise<boolean> {
        console.log(chalk.blue.bold('Testing AI Providers\n'));

        const spinner = ora('Testing AI provider via plugin system...').start();

        try {
            const result = await this.aiFacade.testConnection();

            if (result.success) {
                spinner.succeed(
                    `${result.provider}: ${chalk.green('✓ Connected')} (${result.responseTime}ms)`,
                );
            } else {
                spinner.fail(`${result.provider}: ${chalk.red('✗ Failed')}`);
                console.log(chalk.red(`  Error: ${result.error}`));
                return false;
            }

            return true;
        } catch (error) {
            spinner.fail(`AI provider: ${chalk.red('✗ Failed')}`);
            console.log(chalk.red(`  Error: ${error.message}`));
            return false;
        }
    }

    private async testOtherServices(config: any): Promise<boolean> {
        console.log(chalk.blue.bold('\nTesting Other Services\n'));

        let allPassed = true;

        // Test Git API
        if (config.GIT_TOKEN) {
            const gitResult = await this.testGitApi(config);
            if (!gitResult) {
                allPassed = false;
            }
        }

        // Test Deployment API
        if (config.DEPLOY_TOKEN) {
            const deployResult = await this.testDeployApi(config.DEPLOY_TOKEN, config);
            if (!deployResult) {
                allPassed = false;
            }
        }

        // Test Tavily API
        if (config.PLUGIN_TAVILY_API_KEY) {
            const tavilyResult = await this.testTavilyApi(config.PLUGIN_TAVILY_API_KEY);
            if (!tavilyResult) {
                allPassed = false;
            }
        }

        return allPassed;
    }

    private async testGitApi(config: any): Promise<boolean> {
        const providerId = config.GIT_PROVIDER || 'github';
        const spinner = ora(`Testing Git API (${providerId})...`).start();

        try {
            const user = await this.gitFacade.getUser({
                providerId,
                token: config.GIT_TOKEN,
            });

            spinner.succeed(`Git API: ${chalk.green('✓ Connected')} (User: ${user.login})`);
            return true;
        } catch (error) {
            spinner.fail(`Git API: ${chalk.red('✗ Failed')}`);
            console.log(chalk.red(`  Error: ${error.message}`));
            return false;
        }
    }

    private async testDeployApi(token: string, config: any): Promise<boolean> {
        const provider = config.DEPLOY_PROVIDER || 'vercel';
        const spinner = ora(`Testing Deploy API (${provider})...`).start();

        try {
            const response = await fetch('https://api.vercel.com/v2/user', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (response.ok) {
                const user = await response.json();
                spinner.succeed(
                    `Deploy API: ${chalk.green('✓ Connected')} (User: ${user.user.username})`,
                );
                return true;
            } else {
                spinner.fail(`Deploy API: ${chalk.red('✗ Failed')} (Status: ${response.status})`);
                return false;
            }
        } catch (error) {
            spinner.fail(`Deploy API: ${chalk.red('✗ Failed')}`);
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
}
