import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import { GitFacadeService } from '@ever-works/agent/facades';
import { ConnectionValidationResult } from '@ever-works/plugin';

@Injectable()
export class PluginValidationService {
    constructor(
        private readonly pluginRegistry: PluginRegistryService,
        private readonly pluginSettingsService: PluginSettingsService,
        private readonly gitFacade: GitFacadeService,
    ) {}

    async validateUserPluginConnection(
        pluginId: string,
        userId: string,
    ): Promise<ConnectionValidationResult> {
        const registered = this.pluginRegistry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            throw new NotFoundException(`Plugin not found or not loaded: ${pluginId}`);
        }

        const settings = await this.pluginSettingsService.getSettings(pluginId, {
            userId,
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
                throw new BadRequestException(result.message);
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
