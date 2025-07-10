import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { EverWorksConfig, PartialEverWorksConfig, ConfigValidationResult } from './config.interface';

@Injectable()
export class ConfigService {
    private readonly logger = new Logger(ConfigService.name);
    private readonly configDir = path.join(os.homedir(), '.ever-works');
    private readonly configPath = path.join(this.configDir, 'config.json');

    /**
     * Ensures the configuration directory exists
     */
    private async ensureConfigDir(): Promise<void> {
        try {
            await fs.ensureDir(this.configDir);
        } catch (error) {
            this.logger.error(`Failed to create config directory: ${error.message}`);
            throw new Error(`Failed to create config directory: ${error.message}`);
        }
    }

    /**
     * Loads the configuration from the config file
     */
    async loadConfig(): Promise<EverWorksConfig | null> {
        try {
            if (!(await fs.pathExists(this.configPath))) {
                this.logger.debug('Configuration file does not exist');
                return null;
            }

            const configData = await fs.readJson(this.configPath);
            this.logger.debug('Configuration loaded successfully');
            return configData as EverWorksConfig;
        } catch (error) {
            this.logger.error(`Failed to load configuration: ${error.message}`);
            throw new Error(`Failed to load configuration: ${error.message}`);
        }
    }

    /**
     * Saves the configuration to the config file
     */
    async saveConfig(config: PartialEverWorksConfig): Promise<void> {
        try {
            await this.ensureConfigDir();

            // Remove undefined values to keep the config clean
            const cleanConfig = this.removeUndefinedValues(config);

            await fs.writeJson(this.configPath, cleanConfig, { spaces: 2 });
            this.logger.log('Configuration saved successfully');
        } catch (error) {
            this.logger.error(`Failed to save configuration: ${error.message}`);
            throw new Error(`Failed to save configuration: ${error.message}`);
        }
    }

    /**
     * Checks if configuration exists
     */
    async configExists(): Promise<boolean> {
        try {
            return await fs.pathExists(this.configPath);
        } catch (error) {
            this.logger.error(`Failed to check config existence: ${error.message}`);
            return false;
        }
    }

    /**
     * Gets the configuration file path
     */
    getConfigPath(): string {
        return this.configPath;
    }

    /**
     * Gets the configuration directory path
     */
    getConfigDir(): string {
        return this.configDir;
    }

    /**
     * Loads configuration into process.env
     */
    async loadConfigIntoEnv(): Promise<void> {
        const config = await this.loadConfig();
        if (!config) {
            this.logger.warn('No configuration found to load into environment');
            return;
        }

        // Load all config values into process.env
        Object.entries(config).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                process.env[key] = String(value);
            }
        });

        this.logger.log('Configuration loaded into environment variables');
    }

    /**
     * Validates the configuration
     */
    validateConfig(config: PartialEverWorksConfig): ConfigValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Required fields
        if (!config.GITHUB_APIKEY) errors.push('GITHUB_APIKEY is required');
        if (!config.GITHUB_OWNER) errors.push('GITHUB_OWNER is required');
        if (!config.GIT_NAME) errors.push('GIT_NAME is required');
        if (!config.GIT_EMAIL) errors.push('GIT_EMAIL is required');
        if (!config.AI_DEFAULT_PROVIDER) errors.push('AI_DEFAULT_PROVIDER is required');

        // AI Provider validation
        if (config.AI_DEFAULT_PROVIDER) {
            const providerKey = `${config.AI_DEFAULT_PROVIDER.toUpperCase()}_API_KEY` as keyof EverWorksConfig;
            if (!config[providerKey] && config.AI_DEFAULT_PROVIDER !== 'ollama') {
                errors.push(`API key for default provider ${config.AI_DEFAULT_PROVIDER} is required`);
            }
        }

        // Warnings
        if (!config.TAVILY_API_KEY && (config.EXTRACT_CONTENT_SERVICE === 'tavily' || config.WEB_SEARCH_SERVICE === 'tavily')) {
            warnings.push('TAVILY_API_KEY is recommended when using Tavily services');
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings,
        };
    }

    /**
     * Removes undefined values from configuration
     */
    private removeUndefinedValues(config: PartialEverWorksConfig): PartialEverWorksConfig {
        const cleanConfig: PartialEverWorksConfig = {};

        Object.entries(config).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                (cleanConfig as any)[key] = value;
            }
        });

        return cleanConfig;
    }

    /**
     * Merges new configuration with existing configuration
     */
    async mergeConfig(newConfig: PartialEverWorksConfig): Promise<void> {
        const existingConfig = await this.loadConfig() || {};
        const mergedConfig = { ...existingConfig, ...newConfig };
        await this.saveConfig(mergedConfig);
    }
}
