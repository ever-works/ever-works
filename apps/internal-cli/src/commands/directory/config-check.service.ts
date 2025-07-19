import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import { ConfigService } from '../../config/config.service';

@Injectable()
export class ConfigCheckService {
    constructor(private readonly configService: ConfigService) {}

    /**
     * Checks if the user has completed the setup configuration
     * Returns true if configured, false if not configured
     */
    async checkConfiguration(): Promise<boolean> {
        try {
            const config = await this.configService.loadConfig();

            if (!config) {
                this.displayConfigurationError('No configuration found');
                return false;
            }

            // Validate required configuration
            const validation = this.configService.validateConfig(config);

            if (!validation.isValid) {
                this.displayConfigurationError(
                    'Configuration validation failed',
                    validation.errors,
                );
                return false;
            }

            // Load config into environment for use
            await this.configService.loadConfigIntoEnv();

            return true;
        } catch (error) {
            this.displayConfigurationError('Failed to load configuration', [error.message]);
            return false;
        }
    }

    /**
     * Displays configuration error message and setup instructions
     */
    private displayConfigurationError(message: string, errors?: string[]): void {
        console.log(chalk.red('\n✗ Configuration Error:'), message);

        if (errors && errors.length > 0) {
            console.log(chalk.red('\nErrors:'));
            errors.forEach((error) => console.log(chalk.red(`  • ${error}`)));
        }

        console.log(chalk.yellow('\n⚠ Please complete the setup configuration first.'));
        console.log(
            chalk.gray('Run ') +
                chalk.cyan('ever-works config setup') +
                chalk.gray(' to configure your settings.'),
        );
    }

    /**
     * Checks configuration and exits if not configured
     * This is a convenience method for commands that require configuration
     */
    async requireConfiguration(): Promise<void> {
        const isConfigured = await this.checkConfiguration();
        if (!isConfigured) {
            process.exit(1);
        }
    }
}
