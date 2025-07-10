import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { EverWorksConfig } from './config.interface';

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
    async saveConfig(config: EverWorksConfig): Promise<void> {
        try {
            await this.ensureConfigDir();
            await fs.writeJson(this.configPath, config, { spaces: 2 });
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
     * Converts configuration to environment variables format
     */
    configToEnvVars(config: EverWorksConfig): Record<string, string> {
        const envVars: Record<string, string> = {
            APP_TYPE: config.appType,
            GITHUB_APIKEY: config.githubApiKey,
            GITHUB_OWNER: config.githubOwner,
            GIT_NAME: config.gitName,
            GIT_EMAIL: config.gitEmail,
            AI_DEFAULT_PROVIDER: config.aiDefaultProvider,
            AI_FALLBACK_PROVIDERS: config.aiFallbackProviders.join(','),
            EXTRACT_CONTENT_SERVICE: config.searchServices.extractContentService,
            WEB_SEARCH_SERVICE: config.searchServices.webSearchService,
        };

        // Add deployment provider configs
        if (config.deploymentProviders.vercel?.token) {
            envVars.VERCEL_TOKEN = config.deploymentProviders.vercel.token;
        }

        // Add search service configs
        if (config.searchServices.tavilyApiKey) {
            envVars.TAVILY_API_KEY = config.searchServices.tavilyApiKey;
        }

        // Add AI provider configs
        Object.entries(config.aiProviders).forEach(([provider, providerConfig]) => {
            if (providerConfig) {
                const upperProvider = provider.toUpperCase();
                envVars[`${upperProvider}_API_KEY`] = providerConfig.apiKey;
                envVars[`${upperProvider}_MODEL`] = providerConfig.model;
                envVars[`${upperProvider}_TEMPERATURE`] = providerConfig.temperature.toString();
                envVars[`${upperProvider}_MAX_TOKENS`] = providerConfig.maxTokens.toString();
                
                if (providerConfig.baseUrl) {
                    envVars[`${upperProvider}_BASE_URL`] = providerConfig.baseUrl;
                }
            }
        });

        return envVars;
    }
}
