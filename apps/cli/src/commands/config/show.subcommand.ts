import { SubCommand, CommandRunner } from 'nest-commander';
import { Injectable, Logger } from '@nestjs/common';
import chalk from 'chalk';
import { ConfigService } from '../../config/config.service';

@Injectable()
@SubCommand({
    name: 'show',
    description: 'Show current configuration',
})
export class ShowSubCommand extends CommandRunner {
    private readonly logger = new Logger(ShowSubCommand.name);

    constructor(private readonly configService: ConfigService) {
        super();
    }

    async run(): Promise<void> {
        try {
            const config = await this.configService.loadConfig();
            
            if (!config) {
                console.log(chalk.yellow('⚠ No configuration found.'));
                console.log(chalk.gray('Run ') + chalk.cyan('ever-works config setup') + chalk.gray(' to create a configuration.'));
                return;
            }

            console.log(chalk.cyan.bold('\n📋 Ever Works Configuration\n'));
            console.log(chalk.gray(`Configuration file: ${this.configService.getConfigPath()}\n`));

            // Display configuration sections
            this.displaySection('Application', {
                'App Type': config.APP_TYPE,
            });

            this.displaySection('GitHub & Git', {
                'GitHub Owner': config.GITHUB_OWNER,
                'GitHub API Key': this.maskSecret(config.GITHUB_APIKEY),
                'Git Name': config.GIT_NAME,
                'Git Email': config.GIT_EMAIL,
            });

            this.displaySection('Deployment', {
                'Vercel Token': config.VERCEL_TOKEN ? this.maskSecret(config.VERCEL_TOKEN) : 'Not configured',
            });

            this.displaySection('AI Configuration', {
                'Default Provider': config.AI_DEFAULT_PROVIDER,
                'Fallback Providers': config.AI_FALLBACK_PROVIDERS || 'None',
            });

            // Display configured AI providers
            const aiProviders = this.getConfiguredAiProviders(config);
            if (aiProviders.length > 0) {
                this.displaySection('AI Providers', 
                    aiProviders.reduce((acc, provider) => {
                        acc[provider] = 'Configured ✓';
                        return acc;
                    }, {} as Record<string, string>)
                );
            }

            this.displaySection('Search Services', {
                'Content Extraction': config.EXTRACT_CONTENT_SERVICE,
                'Web Search': config.WEB_SEARCH_SERVICE,
                'Tavily API Key': config.TAVILY_API_KEY ? this.maskSecret(config.TAVILY_API_KEY) : 'Not configured',
            });

            console.log(chalk.gray('\nTo modify configuration, run: ') + chalk.cyan('ever-works config setup'));
            console.log(chalk.gray('To test configuration, run: ') + chalk.cyan('ever-works config test\n'));

        } catch (error) {
            this.logger.error('Failed to show configuration:', error);
            console.log(chalk.red('\n✗ Failed to load configuration:'), error.message);
        }
    }

    private displaySection(title: string, data: Record<string, string | undefined>): void {
        console.log(chalk.blue.bold(`${title}:`));
        Object.entries(data).forEach(([key, value]) => {
            if (value !== undefined) {
                console.log(chalk.gray(`  ${key}: `) + chalk.white(value));
            }
        });
        console.log();
    }

    private maskSecret(secret: string): string {
        if (!secret || secret.length < 8) {
            return '***';
        }
        return secret.substring(0, 4) + '*'.repeat(secret.length - 8) + secret.substring(secret.length - 4);
    }

    private getConfiguredAiProviders(config: any): string[] {
        const providers: string[] = [];
        const providerKeys = ['OPENAI', 'GOOGLE', 'ANTHROPIC', 'OPENROUTER', 'OLLAMA', 'MISTRAL', 'DEEPSEEK', 'GROQ'];

        for (const provider of providerKeys) {
            if (config[`${provider}_API_KEY`] || (provider === 'OLLAMA' && config[`${provider}_BASE_URL`])) {
                providers.push(provider.toLowerCase());
            }
        }

        return providers;
    }
}
