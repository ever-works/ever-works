import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import { GitFacadeService } from '@ever-works/agent/facades';
import { ConnectionValidationResult } from '@ever-works/plugin';

@Injectable()
export class PluginValidationService {
    private readonly logger = new Logger(PluginValidationService.name);

    constructor(
        private readonly pluginRegistry: PluginRegistryService,
        private readonly pluginSettingsService: PluginSettingsService,
        private readonly gitFacade: GitFacadeService,
    ) {}

    /**
     * Non-throwing validation for use after settings save.
     * Returns the validation result or null if the plugin has no validation capability.
     * When directoryId is provided, settings are resolved with directory overrides merged on top of user settings.
     */
    async tryValidateConnection(
        pluginId: string,
        userId: string,
        directoryId?: string,
    ): Promise<ConnectionValidationResult | null> {
        const registered = this.pluginRegistry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            return null;
        }

        const plugin = registered.plugin as unknown as Record<string, unknown>;
        const hasValidateConnection = typeof plugin.validateConnection === 'function';
        const hasIsAvailable = typeof plugin.isAvailable === 'function';
        const isGitProvider = registered.plugin.capabilities.includes('git-provider');

        if (!hasValidateConnection && !hasIsAvailable && !isGitProvider) {
            return null;
        }

        try {
            return await this.validatePluginConnection(pluginId, userId, directoryId);
        } catch (error) {
            if (error instanceof BadRequestException) {
                const response = error.getResponse();
                if (typeof response === 'object' && response !== null) {
                    const body = response as Record<string, unknown>;
                    return {
                        success: false,
                        message: (body.message as string) || 'Validation failed',
                        modelResults:
                            body.modelResults as ConnectionValidationResult['modelResults'],
                    };
                }
                return { success: false, message: String(response) };
            }
            this.logger.warn(`Connection validation failed for plugin "${pluginId}": ${error}`);
            return null;
        }
    }

    /**
     * Throwing validation for the explicit validate-connection endpoint.
     * Kept as alias for backward compatibility.
     */
    async validateUserPluginConnection(
        pluginId: string,
        userId: string,
    ): Promise<ConnectionValidationResult> {
        return this.validatePluginConnection(pluginId, userId);
    }

    /**
     * Core validation logic. Resolves settings with optional directory scope
     * so directory-level model overrides are tested correctly.
     */
    private async validatePluginConnection(
        pluginId: string,
        userId: string,
        directoryId?: string,
    ): Promise<ConnectionValidationResult> {
        const registered = this.pluginRegistry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            throw new NotFoundException(`Plugin not found or not loaded: ${pluginId}`);
        }

        const settings = await this.pluginSettingsService.getSettings(pluginId, {
            userId,
            directoryId,
            includeSecrets: true,
        });

        const plugin = registered.plugin as unknown as Record<string, unknown>;

        // Prefer validateConnection() — plugins self-describe their validation logic
        const validateConnection = plugin.validateConnection as
            | ((s: Record<string, unknown>) => Promise<ConnectionValidationResult>)
            | undefined;

        if (typeof validateConnection === 'function') {
            const result = await validateConnection.call(plugin, settings);
            if (!result.success) {
                throw new BadRequestException({
                    message: result.message,
                    modelResults: result.modelResults,
                });
            }
            return result;
        }

        // For OAuth / git-provider plugins, validate via the git facade
        if (registered.plugin.capabilities.includes('git-provider')) {
            const user = await this.gitFacade.getUser({ userId, providerId: pluginId });
            return {
                success: true,
                message: `Connected to ${registered.plugin.name} as ${user.login}.`,
                details: { username: user.login, email: user.email },
            };
        }

        // Fallback: generic availability check
        const isAvailable = plugin.isAvailable as
            | ((s?: Record<string, unknown>) => Promise<boolean>)
            | undefined;

        if (typeof isAvailable === 'function') {
            const available = await isAvailable.call(plugin, settings);
            if (!available) {
                throw new BadRequestException(
                    `${registered.plugin.name} connection test failed. Check your credentials and try again.`,
                );
            }
            return { success: true, message: `${registered.plugin.name} connection verified.` };
        }

        return { success: true, message: `${registered.plugin.name} settings saved.` };
    }
}
