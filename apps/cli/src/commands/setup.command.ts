import { Command, CommandRunner } from 'nest-commander';
import { Injectable, Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigService } from '../config/config.service';
import { GitHubGitPromptService } from '../prompts/github-git-prompt.service';
import { DeploymentPromptService } from '../prompts/deployment-prompt.service';
import { AiProviderPromptService } from '../prompts/ai-provider-prompt.service';
import { SearchServicePromptService } from '../prompts/search-service-prompt.service';
import { EverWorksConfig, AiProvidersConfig, DeploymentProvidersConfig } from '../config/config.interface';

@Injectable()
@Command({
    name: 'setup',
    description: 'Setup Ever Works CLI configuration',
    options: { isDefault: false },
})
export class SetupCommand extends CommandRunner {
    private readonly logger = new Logger(SetupCommand.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly githubGitPrompt: GitHubGitPromptService,
        private readonly deploymentPrompt: DeploymentPromptService,
        private readonly aiProviderPrompt: AiProviderPromptService,
        private readonly searchServicePrompt: SearchServicePromptService
    ) {
        super();
    }

    async run(): Promise<void> {
        console.log(chalk.cyan.bold('\n🚀 Ever Works CLI Setup\n'));
        console.log(chalk.gray('This setup will configure all necessary settings for the Ever Works agent to function properly.\n'));

        try {
            // Check if configuration already exists
            const configExists = await this.configService.configExists();
            if (configExists) {
                const existingConfig = await this.configService.loadConfig();
                console.log(chalk.yellow('⚠ Configuration already exists at:'));
                console.log(chalk.gray(`   ${this.configService.getConfigPath()}\n`));

                const { overwrite } = await import('inquirer').then(inquirer => 
                    inquirer.default.prompt([{
                        type: 'confirm',
                        name: 'overwrite',
                        message: 'Do you want to overwrite the existing configuration?',
                        default: false,
                    }])
                );

                if (!overwrite) {
                    console.log(chalk.blue('ℹ Setup cancelled. Existing configuration preserved.'));
                    return;
                }
            }

            // Start configuration process
            const spinner = ora('Initializing setup...').start();
            await new Promise(resolve => setTimeout(resolve, 1000));
            spinner.succeed('Setup initialized');

            // 1. GitHub & Git Configuration
            const githubGitConfig = await this.githubGitPrompt.promptGitHubGitConfig();

            // 2. Deployment Provider Configuration
            const deploymentConfig = await this.deploymentPrompt.promptDeploymentConfig();

            // 3. AI Provider Configuration
            const aiConfig = await this.aiProviderPrompt.promptAiProviderConfiguration();

            // 4. Search Service Configuration
            const searchConfig = await this.searchServicePrompt.promptSearchServiceConfiguration();

            // Build final configuration
            const config: EverWorksConfig = {
                appType: 'cli',
                githubApiKey: githubGitConfig.githubApiKey,
                githubOwner: githubGitConfig.githubOwner,
                gitName: githubGitConfig.gitName,
                gitEmail: githubGitConfig.gitEmail,
                deploymentProviders: this.buildDeploymentProviders(deploymentConfig),
                aiDefaultProvider: aiConfig.defaultProvider,
                aiFallbackProviders: aiConfig.fallbackProviders,
                aiProviders: this.buildAiProviders(aiConfig),
                searchServices: {
                    extractContentService: searchConfig.extractContentService,
                    webSearchService: searchConfig.webSearchService,
                    tavilyApiKey: searchConfig.tavilyApiKey,
                },
            };

            // Save configuration
            const saveSpinner = ora('Saving configuration...').start();
            await this.configService.saveConfig(config);
            saveSpinner.succeed('Configuration saved successfully');

            // Display success message
            this.displaySuccessMessage();

        } catch (error) {
            this.logger.error('Setup failed:', error);
            console.log(chalk.red('\n✗ Setup failed:'), error.message);
            process.exit(1);
        }
    }

    private buildDeploymentProviders(deploymentConfig: any): DeploymentProvidersConfig {
        const providers: DeploymentProvidersConfig = {};

        if (deploymentConfig.provider === 'vercel' && deploymentConfig.vercelToken) {
            providers.vercel = {
                token: deploymentConfig.vercelToken,
            };
        }

        return providers;
    }

    private buildAiProviders(aiConfig: any): AiProvidersConfig {
        const providers: AiProvidersConfig = {};

        for (const provider of aiConfig.providers) {
            providers[provider.name] = {
                apiKey: provider.apiKey,
                model: provider.model,
                temperature: provider.temperature,
                maxTokens: provider.maxTokens,
                baseUrl: provider.baseUrl,
            };
        }

        return providers;
    }

    private displaySuccessMessage(): void {
        console.log(chalk.green.bold('\n🎉 Setup completed successfully!\n'));
        console.log(chalk.gray('Configuration saved to:'));
        console.log(chalk.cyan(`   ${this.configService.getConfigPath()}\n`));
        
        console.log(chalk.gray('You can now use the Ever Works CLI with your configured settings.'));
        console.log(chalk.gray('To reconfigure, run: ') + chalk.cyan('ever-works setup'));
        console.log(chalk.gray('To view your configuration, check the file above.\n'));
    }
}
