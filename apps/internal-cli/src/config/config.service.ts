import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import {
    EverWorksConfig,
    PartialEverWorksConfig,
    ConfigValidationResult,
} from './config.interface';

@Injectable()
export class ConfigService {
    private readonly configDir = path.join(os.homedir(), '.ever-works');
    private readonly configPath = path.join(this.configDir, 'config.json');

    /**
     * Ensures the configuration directory exists
     */
    private async ensureConfigDir(): Promise<void> {
        try {
            await fs.ensureDir(this.configDir);
        } catch (error) {
            throw new Error(`Failed to create config directory: ${error.message}`);
        }
    }

    /**
     * Loads the configuration from the config file
     */
    async loadConfig(): Promise<EverWorksConfig | null> {
        try {
            if (!(await fs.pathExists(this.configPath))) {
                return null;
            }

            const configData = await fs.readJson(this.configPath);
            return configData as EverWorksConfig;
        } catch (error) {
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
        } catch (error) {
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
            return;
        }

        // Load all config values into process.env
        Object.entries(config).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                process.env[key] = String(value);
            }
        });
    }

    /**
     * Validates the configuration
     */
    validateConfig(config: PartialEverWorksConfig): ConfigValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Required fields
        if (!config.GH_APIKEY) errors.push('GH_APIKEY is required');
        if (!config.GH_OWNER) errors.push('GH_OWNER is required');
        if (!config.GIT_NAME) errors.push('GIT_NAME is required');
        if (!config.GIT_EMAIL) errors.push('GIT_EMAIL is required');
        // AI Plugin validation - at least one provider should have an API key
        const hasAiProvider =
            config.PLUGIN_OPENROUTER_API_KEY ||
            config.PLUGIN_OPENAI_API_KEY ||
            config.PLUGIN_GOOGLE_API_KEY ||
            config.PLUGIN_ANTHROPIC_API_KEY ||
            config.PLUGIN_GROQ_API_KEY ||
            config.PLUGIN_OLLAMA_BASE_URL;

        if (!hasAiProvider) {
            warnings.push('No AI provider plugin configured. Set at least one PLUGIN_*_API_KEY.');
        }

        // Warnings
        if (
            !config.PLUGIN_TAVILY_API_KEY &&
            (config.EXTRACT_CONTENT_SERVICE === 'tavily' || config.WEB_SEARCH_SERVICE === 'tavily')
        ) {
            warnings.push('PLUGIN_TAVILY_API_KEY is recommended when using Tavily services');
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
        const existingConfig = (await this.loadConfig()) || {};
        const mergedConfig = { ...existingConfig, ...newConfig };
        await this.saveConfig(mergedConfig);
    }
}
