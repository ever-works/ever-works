import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IPlugin,
    ITerminalStreamPlugin,
    ITerminalStreamFacade,
    TerminalSessionHandle,
    TerminalSpawnInput,
    TerminalTransport,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, isTerminalStreamPlugin } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class TerminalStreamFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'TerminalStreamFacadeError';
    }
}

/**
 * Facade for the `terminal-stream` capability (streaming-terminal M5).
 *
 * Resolves WHICH session-host plugin applies for the caller's scope
 * (default `pty-local`; later `pty-ssh` / `k8s-exec` behind the same
 * contract) using the standard provider-resolution + 4-level settings
 * hierarchy from `BaseFacadeService` — nothing above this facade
 * changes when the provider changes.
 *
 * Called by the worker-side session host (spawn) and by API surfaces
 * that need provider identity/diagnostics (resolveProvider). The
 * `TerminalNotProvisionedError` a plugin throws from `spawn` is
 * DELIBERATELY passed through un-wrapped — its stable name is the
 * signal the UI maps to `cannot-connect`.
 */
@Injectable()
export class TerminalStreamFacadeService
    extends BaseFacadeService
    implements ITerminalStreamFacade
{
    protected readonly logger = new Logger(TerminalStreamFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.TERMINAL_STREAM;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /**
     * Resolve the terminal-stream plugin for this scope, or null when
     * none is enabled — callers surface that as the honest
     * `cannot-connect` state rather than a crash.
     */
    async resolveProvider(facadeOptions: FacadeOptions): Promise<ITerminalStreamPlugin | null> {
        try {
            return await this.resolveTypedPlugin(facadeOptions);
        } catch (error) {
            this.logger.debug(
                `terminal-stream provider resolution failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    async spawn(
        input: Omit<TerminalSpawnInput, 'settings'>,
        transport: TerminalTransport,
        facadeOptions: FacadeOptions,
    ): Promise<TerminalSessionHandle> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.spawn({ ...input, settings }, transport);
        } catch (error) {
            if (error instanceof Error && error.name === 'TerminalNotProvisionedError') {
                // Stable-name passthrough: the UI's cannot-connect signal.
                throw error;
            }
            throw this.wrap(error, 'spawn', plugin.id);
        }
    }

    private async resolveTypedPlugin(facadeOptions: FacadeOptions): Promise<ITerminalStreamPlugin> {
        // Resolve untyped, then narrow via the capability guard — resolving
        // pre-typed would make the guard's else-branch `never`.
        const plugin: IPlugin = await this.resolvePlugin(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );
        if (!isTerminalStreamPlugin(plugin)) {
            throw new TerminalStreamFacadeError(
                `Plugin ${plugin.id} does not implement the terminal-stream contract.`,
                'resolve',
                plugin.id,
            );
        }
        return plugin;
    }

    private wrap(error: unknown, operation: string, provider: string): TerminalStreamFacadeError {
        if (error instanceof TerminalStreamFacadeError) return error;
        const message = error instanceof Error ? error.message : 'terminal-stream operation failed';
        const cause = error instanceof Error ? error : undefined;
        return new TerminalStreamFacadeError(message, operation, provider, cause);
    }
}
