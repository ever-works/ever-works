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
     * Resolve the REAL plugin instance behind a possibly-lazy registry stub.
     *
     * A lazy-plugin stub reports EVERY optional method as a function (its
     * proxy forwards unknown property reads), so `typeof` capability probes
     * lie until the real plugin is materialized — validateConnection would
     * "exist", resolve to undefined, and `.success` would 500 the validate
     * endpoint; isAvailable would throw "has no method". Callers here are
     * about to invoke the plugin's validation methods anyway (which
     * materializes regardless), so materializing up front costs nothing extra
     * and makes every probe truthful.
     */
    private async getRealPlugin(pluginLike: unknown): Promise<Record<string, unknown>> {
        const maybeLazy = pluginLike as { __materialize?: () => Promise<unknown> };
        const real =
            typeof maybeLazy.__materialize === 'function'
                ? await maybeLazy.__materialize()
                : pluginLike;
        return real as Record<string, unknown>;
    }

    /**
     * Non-throwing validation for use after settings save.
     * Returns the validation result or null if the plugin has no validation capability.
     * When workId is provided, settings are resolved with work overrides merged on top of user settings.
     */
    async tryValidateConnection(
        pluginId: string,
        userId: string,
        workId?: string,
    ): Promise<ConnectionValidationResult | null> {
        const registered = this.pluginRegistry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            return null;
        }

        let plugin: Record<string, unknown>;
        try {
            plugin = await this.getRealPlugin(registered.plugin);
        } catch (error) {
            // Non-throwing contract: a plugin that fails to materialize has no
            // validation capability we can exercise.
            this.logger.warn(`Failed to materialize plugin "${pluginId}" for validation: ${error}`);
            return null;
        }
        const hasValidateConnection = typeof plugin.validateConnection === 'function';
        const hasIsAvailable = typeof plugin.isAvailable === 'function';
        const isGitProvider = registered.plugin.capabilities.includes('git-provider');

        if (!hasValidateConnection && !hasIsAvailable && !isGitProvider) {
            return null;
        }

        const VALIDATION_TIMEOUT_MS = 20_000;

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                this.validatePluginConnection(pluginId, userId, workId),
                new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(
                        () => reject(new Error('Connection validation timed out')),
                        VALIDATION_TIMEOUT_MS,
                    );
                }),
            ]);
            return result;
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
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
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
     * Core validation logic. Resolves settings with optional work scope
     * so work-level model overrides are tested correctly.
     */
    private async validatePluginConnection(
        pluginId: string,
        userId: string,
        workId?: string,
    ): Promise<ConnectionValidationResult> {
        const registered = this.pluginRegistry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            throw new NotFoundException(`Plugin not found or not loaded: ${pluginId}`);
        }

        const settings = await this.pluginSettingsService.getSettings(pluginId, {
            userId,
            workId,
            includeSecrets: true,
        });

        // Probe the REAL instance — lazy stubs over-report optional methods
        // (see getRealPlugin).
        const plugin = await this.getRealPlugin(registered.plugin);

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
