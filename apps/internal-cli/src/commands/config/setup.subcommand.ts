import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { ConfigService } from '../../config/config.service';
import { GitPromptService } from './prompts/git-prompt.service';
import { DeploymentPromptService } from './prompts/deployment-prompt.service';
import { AiProviderPromptService } from './prompts/ai-provider-prompt.service';
import { SearchServicePromptService } from './prompts/search-service-prompt.service';

import { PartialEverWorksConfig } from '../../config/config.interface';
import { COMMAND } from '../../config';

@SubCommand({
    name: 'setup',
    description: 'Setup Ever Works CLI configuration',
})
export class SetupSubCommand extends CommandRunner {
    private readonly logger = new Logger(SetupSubCommand.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly gitPrompt: GitPromptService,
        private readonly deploymentPrompt: DeploymentPromptService,
        private readonly aiProviderPrompt: AiProviderPromptService,
        private readonly searchServicePrompt: SearchServicePromptService,
    ) {
        super();
    }

    async run(): Promise<void> {
        console.log(chalk.cyan.bold('\n🚀 Ever Works CLI Setup\n'));
        console.log(
            chalk.gray(
                'This setup will configure all necessary settings for the Ever Works agent to function properly.\n',
            ),
        );

        try {
            // Check if configuration already exists
            const configExists = await this.configService.configExists();
            let existingConfig: any = null;

            if (configExists) {
                existingConfig = await this.configService.loadConfig();
                console.log(chalk.yellow('⚠ Configuration already exists at:'));
                console.log(chalk.gray(`   ${this.configService.getConfigPath()}`));
                console.log(chalk.gray('   You can also edit this file manually if needed.\n'));

                const { overwrite } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'overwrite',
                        message: 'Do you want to overwrite the existing configuration?',
                        default: false,
                    },
                ]);

                if (!overwrite) {
                    console.log(chalk.blue('ℹ Setup cancelled. Existing configuration preserved.'));
                    console.log(chalk.gray('To modify specific settings, you can:'));
                    console.log(chalk.gray('  • Edit the config file manually'));
                    console.log(
                        chalk.gray('  • Run ') +
                            chalk.cyan(`${COMMAND} config show`) +
                            chalk.gray(' to view current settings'),
                    );
                    console.log(
                        chalk.gray('  • Run ') +
                            chalk.cyan(`${COMMAND} config test`) +
                            chalk.gray(' to test your configuration'),
                    );
                    return;
                }

                console.log(chalk.blue('ℹ Using existing values as defaults where available...\n'));
            }

            // Start configuration process
            const spinner = ora('Initializing setup...').start();
            await new Promise((resolve) => setTimeout(resolve, 1000));
            spinner.succeed('Setup initialized');

            // Build configuration step by step
            const config: PartialEverWorksConfig = {
                APP_TYPE: 'cli',
            };

            // 1. Git Provider Configuration
            const gitConfig = await this.gitPrompt.promptGitConfig(existingConfig);

            config.GIT_PROVIDER = gitConfig.provider;
            config.GIT_TOKEN = gitConfig.gitToken;
            config.GIT_OWNER = gitConfig.gitOwner;
            config.GIT_NAME = gitConfig.gitName;
            config.GIT_EMAIL = gitConfig.gitEmail;

            // 2. Deployment Provider Configuration
            const deploymentConfig =
                await this.deploymentPrompt.promptDeploymentConfig(existingConfig);

            if (deploymentConfig.provider !== 'ignore' && deploymentConfig.token) {
                config.DEPLOY_PROVIDER = deploymentConfig.provider;
                config.DEPLOY_TOKEN = deploymentConfig.token;
            }

            // 3. AI Provider Configuration
            const aiConfig =
                await this.aiProviderPrompt.promptAiProviderConfiguration(existingConfig);

            if (aiConfig.defaultProvider && aiConfig.defaultProvider !== 'ignore') {
                config.AI_DEFAULT_PROVIDER = aiConfig.defaultProvider;
                config.AI_FALLBACK_PROVIDERS = aiConfig.fallbackProviders.join(',');

                // Add AI provider configurations
                for (const provider of aiConfig.providers) {
                    const upperProvider = provider.name.toUpperCase();
                    config[`${upperProvider}_API_KEY` as keyof PartialEverWorksConfig] =
                        provider.apiKey;
                    config[`${upperProvider}_MODEL` as keyof PartialEverWorksConfig] =
                        provider.model;
                    config[`${upperProvider}_TEMPERATURE` as keyof PartialEverWorksConfig] =
                        provider.temperature.toString();
                    config[`${upperProvider}_MAX_TOKENS` as keyof PartialEverWorksConfig] =
                        provider.maxTokens.toString();

                    if (provider.baseUrl) {
                        config[`${upperProvider}_BASE_URL` as keyof PartialEverWorksConfig] =
                            provider.baseUrl;
                    }
                }
            }

            // 4. Search Service Configuration
            const searchConfig =
                await this.searchServicePrompt.promptSearchServiceConfiguration(existingConfig);
            config.EXTRACT_CONTENT_SERVICE = searchConfig.extractContentService;
            config.WEB_SEARCH_SERVICE = searchConfig.webSearchService;
            if (searchConfig.tavilyApiKey) {
                config.PLUGIN_TAVILY_API_KEY = searchConfig.tavilyApiKey;
            }

            // 5. Validate configuration
            const validation = this.configService.validateConfig(config);
            if (!validation.isValid) {
                console.log(chalk.red('\n✗ Configuration validation failed:'));
                validation.errors.forEach((error) => console.log(chalk.red(`  • ${error}`)));
                return;
            }

            if (validation.warnings.length > 0) {
                console.log(chalk.yellow('\n⚠ Configuration warnings:'));
                validation.warnings.forEach((warning) =>
                    console.log(chalk.yellow(`  • ${warning}`)),
                );
            }

            // 6. Save configuration
            const saveSpinner = ora('Saving configuration...').start();
            await this.configService.saveConfig(config);
            saveSpinner.succeed('Configuration saved successfully');

            // 7. Display success message
            this.displaySuccessMessage();
        } catch (error) {
            this.logger.error('Setup failed:', error);
            console.log(chalk.red('\n✗ Setup failed:'), error.message);
            process.exit(1);
        }
    }

    private displaySuccessMessage(): void {
        console.log(chalk.green.bold('\n🎉 Setup completed successfully!\n'));
        console.log(chalk.gray('Configuration saved to:'));
        console.log(chalk.cyan(`   ${this.configService.getConfigPath()}\n`));

        console.log(
            chalk.gray('You can now use the Ever Works CLI with your configured settings.'),
        );
        console.log(chalk.gray('To reconfigure, run: ') + chalk.cyan(`${COMMAND} config setup`));
        console.log(
            chalk.gray('To view your configuration, run: ') + chalk.cyan(`${COMMAND} config show`),
        );
        console.log(
            chalk.gray('To test your configuration, run: ') +
                chalk.cyan(`${COMMAND} config test\n`),
        );
    }
}
