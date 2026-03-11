import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import { GitFacadeService } from '@ever-works/agent/facades';

export interface PluginConnectionValidationResult {
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
}

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
    ): Promise<PluginConnectionValidationResult> {
        const registered = this.pluginRegistry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            throw new NotFoundException(`Plugin not found or not loaded: ${pluginId}`);
        }

        const settings = await this.pluginSettingsService.getResolvedSettings(pluginId, {
            userId,
            includeSecrets: true,
        });

        const plugin = registered.plugin as unknown as Record<string, unknown>;

        if (pluginId === 'vercel') {
            const token = settings.apiToken as unknown as string | undefined;
            if (!token) {
                throw new BadRequestException('Enter a Vercel API token before validating.');
            }

            const validateToken = plugin.validateToken as
                | ((token: string) => Promise<boolean>)
                | undefined;
            const getAuthenticatedUser = plugin.getAuthenticatedUser as
                | ((token: string) => Promise<{ username: string; email?: string } | null>)
                | undefined;

            const valid = (await validateToken?.(token)) ?? false;
            if (!valid) {
                throw new BadRequestException('Vercel rejected the API token.');
            }

            const user = await getAuthenticatedUser?.(token);

            return {
                success: true,
                message: user?.username
                    ? `Connected to Vercel as ${user.username}.`
                    : 'Vercel connection verified.',
                details: user ? { username: user.username, email: user.email } : undefined,
            };
        }

        if (registered.plugin.capabilities.includes('git-provider')) {
            const user = await this.gitFacade.getUser({ userId, providerId: pluginId });

            return {
                success: true,
                message: `Connected to ${registered.plugin.name} as ${user.login}.`,
                details: {
                    username: user.login,
                    email: user.email,
                },
            };
        }

        const isAvailable = plugin.isAvailable as
            | ((settings?: Record<string, unknown>) => Promise<boolean>)
            | undefined;

        if (typeof isAvailable === 'function') {
            const available = await isAvailable(settings);
            if (!available) {
                throw new BadRequestException(
                    `${registered.plugin.name} connection test failed. Check your credentials and try again.`,
                );
            }

            return {
                success: true,
                message: `${registered.plugin.name} connection verified.`,
            };
        }

        return {
            success: true,
            message: `${registered.plugin.name} settings saved.`,
        };
    }
}
