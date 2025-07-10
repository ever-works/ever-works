import { SubCommand, CommandRunner } from 'nest-commander';
import { Injectable, Logger } from '@nestjs/common';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigService } from '../../config/config.service';

@Injectable()
@SubCommand({
    name: 'unset',
    description: 'Remove a configuration value',
    arguments: '[key]',
})
export class UnsetSubCommand extends CommandRunner {
    private readonly logger = new Logger(UnsetSubCommand.name);

    constructor(private readonly configService: ConfigService) {
        super();
    }

    async run(passedParams: string[]): Promise<void> {
        try {
            // Load existing config
            const existingConfig = await this.configService.loadConfig();

            if (!existingConfig || Object.keys(existingConfig).length === 0) {
                console.log(chalk.yellow('⚠ No configuration found to modify'));
                console.log(
                    chalk.gray('Run ') +
                        chalk.cyan('ever-works config setup') +
                        chalk.gray(' to create a configuration.'),
                );
                return;
            }

            let keyToUnset: string | null = null;

            if (passedParams.length > 0) {
                // Key provided as argument
                keyToUnset = passedParams[0];

                if (!existingConfig.hasOwnProperty(keyToUnset)) {
                    console.log(chalk.red(`✗ Configuration key '${keyToUnset}' does not exist`));
                    console.log(chalk.gray('Available keys:'));
                    this.displayAvailableKeys(existingConfig);
                    return;
                }
            } else {
                // No key provided, show interactive selection
                keyToUnset = await this.promptForKey(existingConfig);
                if (!keyToUnset) {
                    console.log(chalk.blue('ℹ Operation cancelled'));
                    return;
                }
            }

            // Show current value and confirm
            const currentValue = existingConfig[keyToUnset];
            const maskedValue = this.maskSensitiveValue(keyToUnset, currentValue);

            console.log(chalk.yellow(`\nAbout to remove:`));
            console.log(chalk.gray(`  Key: ${keyToUnset}`));
            console.log(chalk.gray(`  Current Value: ${maskedValue}`));

            // Check if this is a critical key
            const isCritical = this.isCriticalKey(keyToUnset);
            if (isCritical) {
                console.log(chalk.red('⚠ Warning: This is a critical configuration key!'));
                console.log(chalk.gray(this.getCriticalKeyWarning(keyToUnset)));
            }

            const { confirmed } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirmed',
                    message: `Are you sure you want to remove '${keyToUnset}'?`,
                    default: false,
                },
            ]);

            if (!confirmed) {
                console.log(chalk.blue('ℹ Operation cancelled'));
                return;
            }

            // Remove the key
            const updatedConfig = { ...existingConfig };
            delete updatedConfig[keyToUnset];

            await this.configService.saveConfig(updatedConfig);

            console.log(chalk.green(`✓ Successfully removed '${keyToUnset}' from configuration`));

            // Show related keys that might need attention
            this.showRelatedKeysWarning(keyToUnset, updatedConfig);
        } catch (error) {
            this.logger.error('Failed to unset configuration:', error);
            console.log(chalk.red('\n✗ Failed to unset configuration:'), error.message);
        }
    }

    private async promptForKey(config: any): Promise<string | null> {
        const configKeys = Object.keys(config);

        if (configKeys.length === 0) {
            console.log(chalk.yellow('⚠ No configuration keys found'));
            return null;
        }

        // Group keys by category for better UX
        const groupedKeys = this.groupConfigKeys(configKeys);
        const choices: any[] = [];

        Object.entries(groupedKeys).forEach(([category, keys]) => {
            if (keys.length > 0) {
                choices.push(new inquirer.Separator(`--- ${category} ---`));
                keys.forEach((key) => {
                    const value = config[key];
                    const maskedValue = this.maskSensitiveValue(key, value);
                    const isCritical = this.isCriticalKey(key);
                    const prefix = isCritical ? '⚠ ' : '';
                    choices.push({
                        name: `${prefix}${key} = ${maskedValue}`,
                        value: key,
                    });
                });
            }
        });

        choices.push(new inquirer.Separator());
        choices.push({ name: 'Cancel', value: null });

        const { selectedKey } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedKey',
                message: 'Select a configuration key to remove:',
                choices,
                pageSize: 15,
            },
        ]);

        return selectedKey;
    }

    private groupConfigKeys(keys: string[]): Record<string, string[]> {
        const groups: Record<string, string[]> = {
            Application: [],
            'GitHub & Git': [],
            'AI Providers': [],
            Deployment: [],
            'Search Services': [],
            Other: [],
        };

        keys.forEach((key) => {
            if (key === 'APP_TYPE') {
                groups['Application'].push(key);
            } else if (key.startsWith('GITHUB_') || key.startsWith('GIT_')) {
                groups['GitHub & Git'].push(key);
            } else if (
                key.startsWith('AI_') ||
                key.includes('_API_KEY') ||
                key.includes('_MODEL') ||
                key.includes('_TEMPERATURE') ||
                key.includes('_MAX_TOKENS') ||
                key.includes('_BASE_URL')
            ) {
                groups['AI Providers'].push(key);
            } else if (key.includes('VERCEL') || key.includes('DEPLOY')) {
                groups['Deployment'].push(key);
            } else if (key.includes('SEARCH') || key.includes('TAVILY')) {
                groups['Search Services'].push(key);
            } else {
                groups['Other'].push(key);
            }
        });

        return groups;
    }

    private displayAvailableKeys(config: any): void {
        const groupedKeys = this.groupConfigKeys(Object.keys(config));

        Object.entries(groupedKeys).forEach(([category, keys]) => {
            if (keys.length > 0) {
                console.log(chalk.blue(`\n${category}:`));
                keys.forEach((key) => {
                    const value = config[key];
                    const maskedValue = this.maskSensitiveValue(key, value);
                    console.log(chalk.gray(`  ${key} = ${maskedValue}`));
                });
            }
        });
    }

    private maskSensitiveValue(key: string, value: string): string {
        const sensitiveKeys = ['API_KEY', 'TOKEN', 'APIKEY'];
        const isSensitive = sensitiveKeys.some((sensitive) => key.includes(sensitive));

        if (isSensitive && value && value.length > 8) {
            return (
                value.substring(0, 4) +
                '*'.repeat(value.length - 8) +
                value.substring(value.length - 4)
            );
        }

        return value || '<empty>';
    }

    private isCriticalKey(key: string): boolean {
        const criticalKeys = [
            'AI_DEFAULT_PROVIDER',
            'GITHUB_APIKEY',
            'GITHUB_OWNER',
            'GIT_NAME',
            'GIT_EMAIL',
        ];
        return criticalKeys.includes(key);
    }

    private getCriticalKeyWarning(key: string): string {
        const warnings: Record<string, string> = {
            AI_DEFAULT_PROVIDER: 'Removing this will disable AI functionality',
            GITHUB_APIKEY: 'Removing this will disable GitHub API access',
            GITHUB_OWNER: 'Removing this will break repository operations',
            GIT_NAME: 'Removing this will break Git commit operations',
            GIT_EMAIL: 'Removing this will break Git commit operations',
        };
        return warnings[key] || 'This may affect core functionality';
    }

    private showRelatedKeysWarning(removedKey: string, remainingConfig: any): void {
        // Check for orphaned related keys
        if (removedKey === 'AI_DEFAULT_PROVIDER') {
            const fallbackProviders = remainingConfig['AI_FALLBACK_PROVIDERS'];
            if (fallbackProviders) {
                console.log(
                    chalk.yellow(
                        '⚠ Consider updating AI_FALLBACK_PROVIDERS or setting a new default provider',
                    ),
                );
            }
        }

        if (removedKey.includes('_API_KEY')) {
            const provider = removedKey.replace('_API_KEY', '');
            const relatedKeys = Object.keys(remainingConfig).filter(
                (key) => key.startsWith(provider) && key !== removedKey,
            );

            if (relatedKeys.length > 0) {
                console.log(chalk.yellow(`⚠ Related keys still exist: ${relatedKeys.join(', ')}`));
                console.log(chalk.gray('You may want to remove these as well'));
            }
        }
    }
}
