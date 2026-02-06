import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import { ConfigService } from '../../config/config.service';
import { COMMAND } from '../../config';

@SubCommand({
    name: 'switch-ai',
    description: 'Show configured AI provider plugins',
})
export class SwitchAiSubCommand extends CommandRunner {
    private readonly logger = new Logger(SwitchAiSubCommand.name);

    constructor(private readonly configService: ConfigService) {
        super();
    }

    async run(): Promise<void> {
        try {
            const existingConfig = await this.configService.loadConfig();

            if (!existingConfig) {
                console.log(chalk.yellow('⚠ No configuration found'));
                console.log(
                    chalk.gray('Run ') +
                        chalk.cyan(`${COMMAND} config setup`) +
                        chalk.gray(' to create a configuration.'),
                );
                return;
            }

            const configuredProviders = this.getConfiguredProviders(existingConfig);

            console.log(chalk.cyan.bold('\n🤖 Configured AI Provider Plugins\n'));

            if (configuredProviders.length === 0) {
                console.log(chalk.yellow('⚠ No AI provider plugins configured'));
                console.log(
                    chalk.gray('Configure provider API keys with ') +
                        chalk.cyan(`${COMMAND} config setup`) +
                        chalk.gray(' to enable AI providers.'),
                );
                return;
            }

            for (const provider of configuredProviders) {
                console.log(chalk.green(`  ✓ ${provider}`));
            }

            console.log(
                chalk.gray(
                    '\nProvider priority is managed via the plugin system in the API/web admin.',
                ),
            );
            console.log(
                chalk.gray('To modify API keys, run: ') + chalk.cyan(`${COMMAND} config setup\n`),
            );
        } catch (error) {
            this.logger.error('Failed to list AI providers:', error);
            console.log(chalk.red('\n✗ Failed to list AI providers:'), error.message);
        }
    }

    private getConfiguredProviders(config: any): string[] {
        const providers: string[] = [];
        const providerKeys = ['OPENROUTER', 'OPENAI', 'GOOGLE', 'ANTHROPIC', 'GROQ', 'OLLAMA'];

        for (const provider of providerKeys) {
            if (
                config[`PLUGIN_${provider}_API_KEY`] ||
                (provider === 'OLLAMA' && config[`PLUGIN_${provider}_BASE_URL`])
            ) {
                providers.push(provider.toLowerCase());
            }
        }

        return providers;
    }
}
