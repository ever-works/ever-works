import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { ConfigChecker, displayConfigurationError } from '@ever-works/cli-shared';

@Injectable()
export class ConfigCheckService implements ConfigChecker {
    constructor(private readonly configService: ConfigService) {}

    /**
     * Checks if the user has completed the setup configuration
     * Returns true if configured, false if not configured
     */
    async checkConfiguration(): Promise<boolean> {
        try {
            const config = await this.configService.loadConfig();

            if (!config) {
                displayConfigurationError('No configuration found');
                return false;
            }

            // Validate required configuration
            const validation = this.configService.validateConfig(config);

            if (!validation.isValid) {
                displayConfigurationError('Configuration validation failed', validation.errors);
                return false;
            }

            return true;
        } catch (error) {
            displayConfigurationError('Failed to load configuration', [error.message]);
            return false;
        }
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
