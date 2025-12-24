import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigService } from '../../config/config.service';
import { COMMAND } from '../../config';

@SubCommand({
    name: 'switch-ai',
    description: 'Switch between configured AI providers',
})
export class SwitchAiSubCommand extends CommandRunner {
    private readonly logger = new Logger(SwitchAiSubCommand.name);

    constructor(private readonly configService: ConfigService) {
        super();
    }

    async run(): Promise<void> {
        try {
            // Load existing config
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

            const currentDefault = existingConfig.AI_DEFAULT_PROVIDER;
            const fallbackProviders =
                existingConfig.AI_FALLBACK_PROVIDERS?.split(',').filter((p) => p.trim()) || [];

            if (!currentDefault) {
                console.log(chalk.yellow('⚠ No default AI provider configured'));
                console.log(
                    chalk.gray('Run ') +
                        chalk.cyan(`${COMMAND} config setup`) +
                        chalk.gray(' to configure AI providers.'),
                );
                return;
            }

            // Get all configured AI providers
            const configuredProviders = this.getConfiguredProviders(existingConfig);

            if (configuredProviders.length < 2) {
                console.log(chalk.yellow('⚠ Only one AI provider is configured'));
                console.log(
                    chalk.gray('Configure additional providers with ') +
                        chalk.cyan(`${COMMAND} config setup`) +
                        chalk.gray(' to enable switching.'),
                );
                return;
            }

            // Display current configuration
            console.log(chalk.cyan.bold('\n🤖 Current AI Provider Configuration\n'));
            console.log(chalk.blue('Default Provider:') + chalk.white(` ${currentDefault}`));
            if (fallbackProviders.length > 0) {
                console.log(
                    chalk.blue('Fallback Providers:') +
                        chalk.white(` ${fallbackProviders.join(', ')}`),
                );
            } else {
                console.log(chalk.gray('Fallback Providers: None'));
            }

            // Show available actions
            const actions = this.getAvailableActions(
                currentDefault,
                fallbackProviders,
                configuredProviders,
            );

            if (actions.length === 0) {
                console.log(chalk.yellow('\n⚠ No switching actions available'));
                return;
            }

            const { selectedAction } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedAction',
                    message: '\nWhat would you like to do?',
                    choices: [
                        ...actions,
                        new inquirer.Separator(),
                        { name: 'Cancel', value: 'cancel' },
                    ],
                },
            ]);

            if (selectedAction === 'cancel') {
                console.log(chalk.blue('ℹ Operation cancelled'));
                return;
            }

            // Execute the selected action
            await this.executeAction(selectedAction, existingConfig);
        } catch (error) {
            this.logger.error('Failed to switch AI provider:', error);
            console.log(chalk.red('\n✗ Failed to switch AI provider:'), error.message);
        }
    }

    private getConfiguredProviders(config: any): string[] {
        const providers: string[] = [];
        const providerKeys = [
            'OPENAI',
            'GOOGLE',
            'ANTHROPIC',
            'OPENROUTER',
            'OLLAMA',
            'GROQ',
            'CUSTOM',
        ];

        for (const provider of providerKeys) {
            if (
                config[`${provider}_API_KEY`] ||
                (provider === 'OLLAMA' && config[`${provider}_BASE_URL`])
            ) {
                providers.push(provider.toLowerCase());
            }
        }

        return providers;
    }

    private getAvailableActions(
        currentDefault: string,
        fallbackProviders: string[],
        configuredProviders: string[],
    ): any[] {
        const actions: any[] = [];

        // Action 1: Switch default with first fallback
        if (fallbackProviders.length > 0) {
            const firstFallback = fallbackProviders[0];
            actions.push({
                name: `Switch default: ${currentDefault} ↔ ${firstFallback}`,
                value: { type: 'swap_default_fallback', fallback: firstFallback },
            });
        }

        // Action 2: Set a specific provider as default
        const otherProviders = configuredProviders.filter((p) => p !== currentDefault);
        if (otherProviders.length > 0) {
            actions.push({
                name: 'Set a different provider as default',
                value: { type: 'set_new_default' },
            });
        }

        // Action 3: Reorder fallback providers
        if (fallbackProviders.length > 1) {
            actions.push({
                name: 'Reorder fallback providers',
                value: { type: 'reorder_fallbacks' },
            });
        }

        // Action 4: Add/remove fallback providers
        const unconfiguredFallbacks = configuredProviders.filter(
            (p) => p !== currentDefault && !fallbackProviders.includes(p),
        );

        if (unconfiguredFallbacks.length > 0 || fallbackProviders.length > 0) {
            actions.push({
                name: 'Manage fallback providers',
                value: { type: 'manage_fallbacks' },
            });
        }

        return actions;
    }

    private async executeAction(action: any, config: any): Promise<void> {
        const updatedConfig = { ...config };

        switch (action.type) {
            case 'swap_default_fallback':
                await this.swapDefaultFallback(updatedConfig, action.fallback);
                break;
            case 'set_new_default':
                await this.setNewDefault(updatedConfig);
                break;
            case 'reorder_fallbacks':
                await this.reorderFallbacks(updatedConfig);
                break;
            case 'manage_fallbacks':
                await this.manageFallbacks(updatedConfig);
                break;
        }
    }

    private async swapDefaultFallback(config: any, fallbackToSwap: string): Promise<void> {
        const currentDefault = config.AI_DEFAULT_PROVIDER;
        const fallbackProviders =
            config.AI_FALLBACK_PROVIDERS?.split(',').filter((p) => p.trim()) || [];

        // Remove the fallback from the list and add current default
        const newFallbacks = fallbackProviders.filter((p) => p !== fallbackToSwap);
        newFallbacks.unshift(currentDefault);

        // Update config
        config.AI_DEFAULT_PROVIDER = fallbackToSwap;
        config.AI_FALLBACK_PROVIDERS = newFallbacks.join(',');

        await this.configService.saveConfig(config);

        console.log(chalk.green('\n✓ Successfully swapped AI providers:'));
        console.log(chalk.gray(`  New Default: ${fallbackToSwap}`));
        console.log(chalk.gray(`  New Fallbacks: ${newFallbacks.join(', ')}`));
    }

    private async setNewDefault(config: any): Promise<void> {
        const currentDefault = config.AI_DEFAULT_PROVIDER;
        const configuredProviders = this.getConfiguredProviders(config);
        const otherProviders = configuredProviders.filter((p) => p !== currentDefault);

        const { newDefault } = await inquirer.prompt([
            {
                type: 'list',
                name: 'newDefault',
                message: 'Select new default provider:',
                choices: otherProviders.map((provider) => ({
                    name: provider,
                    value: provider,
                })),
            },
        ]);

        // Update fallbacks to include old default
        const fallbackProviders =
            config.AI_FALLBACK_PROVIDERS?.split(',').filter((p) => p.trim()) || [];

        if (!fallbackProviders.includes(currentDefault)) {
            fallbackProviders.unshift(currentDefault);
        }

        config.AI_DEFAULT_PROVIDER = newDefault;
        config.AI_FALLBACK_PROVIDERS = fallbackProviders.filter((p) => p !== newDefault).join(',');

        await this.configService.saveConfig(config);

        console.log(chalk.green('\n✓ Successfully changed default AI provider:'));
        console.log(chalk.gray(`  New Default: ${newDefault}`));
        console.log(chalk.gray(`  Fallbacks: ${fallbackProviders.join(', ')}`));
    }

    private async reorderFallbacks(config: any): Promise<void> {
        const fallbackProviders =
            config.AI_FALLBACK_PROVIDERS?.split(',').filter((p) => p.trim()) || [];

        console.log(chalk.blue('\nCurrent fallback order:'));
        fallbackProviders.forEach((provider, index) => {
            console.log(chalk.gray(`  ${index + 1}. ${provider}`));
        });

        // Simple reordering by selecting new first priority
        const { newFirst } = await inquirer.prompt([
            {
                type: 'list',
                name: 'newFirst',
                message: 'Select which provider should be the first fallback:',
                choices: fallbackProviders.map((provider) => ({
                    name: provider,
                    value: provider,
                })),
            },
        ]);

        // Reorder: move selected to front
        const reordered = [newFirst, ...fallbackProviders.filter((p) => p !== newFirst)];
        config.AI_FALLBACK_PROVIDERS = reordered.join(',');

        await this.configService.saveConfig(config);

        console.log(chalk.green('\n✓ Successfully reordered fallback providers:'));
        reordered.forEach((provider, index) => {
            console.log(chalk.gray(`  ${index + 1}. ${provider}`));
        });
    }

    private async manageFallbacks(config: any): Promise<void> {
        const currentDefault = config.AI_DEFAULT_PROVIDER;
        const configuredProviders = this.getConfiguredProviders(config);

        const currentFallbacks =
            config.AI_FALLBACK_PROVIDERS?.split(',').filter((p) => p.trim()) || [];

        const availableForFallback = configuredProviders.filter((p) => p !== currentDefault);

        const { selectedFallbacks } = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'selectedFallbacks',
                message: 'Select fallback providers (in order of preference):',
                choices: availableForFallback.map((provider) => ({
                    name: provider,
                    value: provider,
                    checked: currentFallbacks.includes(provider),
                })),
            },
        ]);

        config.AI_FALLBACK_PROVIDERS = selectedFallbacks.join(',');

        await this.configService.saveConfig(config);

        console.log(chalk.green('\n✓ Successfully updated fallback providers:'));
        if (selectedFallbacks.length > 0) {
            selectedFallbacks.forEach((provider: string, index: number) => {
                console.log(chalk.gray(`  ${index + 1}. ${provider}`));
            });
        } else {
            console.log(chalk.gray('  No fallback providers configured'));
        }
    }
}
