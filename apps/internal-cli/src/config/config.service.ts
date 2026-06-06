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
    private readonly logger = new Logger(ConfigService.name);
    private readonly configDir = path.join(os.homedir(), '.ever-works');
    private readonly configPath = path.join(this.configDir, 'config.json');

    /**
     * Security: explicit allowlist of config keys that may be copied into
     * process.env. Mirrors the `EverWorksConfig` interface key set. Anything
     * NOT in this set (e.g. PATH, NODE_OPTIONS, LD_PRELOAD, NODE_PATH,
     * __proto__) found in ~/.ever-works/config.json is ignored so a tampered
     * config file cannot inject arbitrary environment variables into the CLI
     * or the agent subprocesses it spawns.
     */
    private static readonly ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set<keyof EverWorksConfig>([
        'APP_TYPE',
        'GIT_PROVIDER',
        'GIT_TOKEN',
        'GIT_OWNER',
        'GIT_NAME',
        'GIT_EMAIL',
        'DEPLOY_PROVIDER',
        'DEPLOY_TOKEN',
        'PLUGIN_OPENROUTER_API_KEY',
        'PLUGIN_OPENROUTER_DEFAULT_MODEL',
        'PLUGIN_OPENAI_API_KEY',
        'PLUGIN_OPENAI_DEFAULT_MODEL',
        'PLUGIN_GOOGLE_API_KEY',
        'PLUGIN_GOOGLE_DEFAULT_MODEL',
        'PLUGIN_ANTHROPIC_API_KEY',
        'PLUGIN_ANTHROPIC_DEFAULT_MODEL',
        'PLUGIN_GROQ_API_KEY',
        'PLUGIN_GROQ_DEFAULT_MODEL',
        'PLUGIN_OLLAMA_BASE_URL',
        'PLUGIN_OLLAMA_DEFAULT_MODEL',
        'EXTRACT_CONTENT_SERVICE',
        'WEB_SEARCH_SERVICE',
        'PLUGIN_TAVILY_API_KEY',
        'DATABASE_TYPE',
        'DATABASE_IN_MEMORY',
        'DATABASE_LOGGING',
    ]);

    /**
     * Ensures the configuration work exists
     */
    private async ensureConfigDir(): Promise<void> {
        try {
            await fs.ensureDir(this.configDir);
        } catch (error) {
            throw new Error(`Failed to create config work: ${error.message}`);
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
     * Gets the configuration work path
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

        // Load config values into process.env.
        // Security: only copy keys on the explicit allowlist (mirrors the
        // EverWorksConfig interface). Reject any other key (PATH, NODE_OPTIONS,
        // LD_PRELOAD, __proto__, etc.) so a tampered config file cannot inject
        // arbitrary environment variables. Also guard against prototype-chain
        // keys via Object.hasOwn.
        Object.entries(config).forEach(([key, value]) => {
            if (value === undefined || value === null) {
                return;
            }
            if (!Object.prototype.hasOwnProperty.call(config, key)) {
                return;
            }
            if (!ConfigService.ALLOWED_ENV_KEYS.has(key)) {
                this.logger.warn(`Ignoring unrecognised config key not on env allowlist: ${key}`);
                return;
            }
            process.env[key] = String(value);
        });

        // Default git provider to 'github' if not set
        if (!process.env.GIT_PROVIDER) {
            process.env.GIT_PROVIDER = 'github';
        }

        // Map new keys to legacy env vars for downstream @ever-works/agent code
        if (process.env.GIT_TOKEN && !process.env.GH_APIKEY) {
            process.env.GH_APIKEY = process.env.GIT_TOKEN;
        }
        if (process.env.GIT_OWNER && !process.env.GH_OWNER) {
            process.env.GH_OWNER = process.env.GIT_OWNER;
        }
    }

    /**
     * Validates the configuration
     */
    validateConfig(config: PartialEverWorksConfig): ConfigValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Required fields
        if (!config.GIT_TOKEN) errors.push('GIT_TOKEN is required');
        if (!config.GIT_OWNER) errors.push('GIT_OWNER is required');
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
