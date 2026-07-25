import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IPlugin,
    IWorkspacePlugin,
    IWorkspaceFacade,
    WorkspaceProvisionSpec,
    WorkspaceHandle,
    WorkspaceFinalizeResult,
    WorkspaceMergeSimulation,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, isWorkspacePlugin } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class WorkspaceFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'WorkspaceFacadeError';
    }
}

/**
 * Facade for the `workspace` capability (worktree-per-Task, Wave 2 M2).
 *
 * Standard provider resolution + settings hierarchy. The
 * `WorkspaceNotProvisionedError` a plugin throws passes through
 * UN-wrapped (stable name → loud, actionable failure); everything else
 * wraps with provider identity.
 */
@Injectable()
export class WorkspaceFacadeService extends BaseFacadeService implements IWorkspaceFacade {
    protected readonly logger = new Logger(WorkspaceFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.WORKSPACE;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    async provision(
        spec: Omit<WorkspaceProvisionSpec, 'settings'>,
        facadeOptions: FacadeOptions,
    ): Promise<WorkspaceHandle> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.provision({ ...spec, settings });
        } catch (error) {
            throw this.passOrWrap(error, 'provision', plugin.id);
        }
    }

    async finalize(
        handle: WorkspaceHandle,
        opts: { commitMessage: string; push: boolean },
        facadeOptions: FacadeOptions,
    ): Promise<WorkspaceFinalizeResult> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        try {
            return await plugin.finalize(handle, opts);
        } catch (error) {
            throw this.passOrWrap(error, 'finalize', plugin.id);
        }
    }

    async simulateMerge(
        handle: WorkspaceHandle,
        targetRef: string,
        facadeOptions: FacadeOptions,
    ): Promise<WorkspaceMergeSimulation> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        try {
            return await plugin.simulateMerge(handle, targetRef);
        } catch (error) {
            throw this.passOrWrap(error, 'simulateMerge', plugin.id);
        }
    }

    async teardown(handle: WorkspaceHandle, facadeOptions: FacadeOptions): Promise<void> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        try {
            await plugin.teardown(handle);
        } catch (error) {
            // Teardown failures are logged, never thrown — a leaked
            // workspace is the GC sweeper's job, not the run's problem.
            this.logger.warn(
                `workspace teardown failed (${plugin.id}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private passOrWrap(error: unknown, operation: string, provider: string): Error {
        if (error instanceof Error && error.name === 'WorkspaceNotProvisionedError') {
            return error;
        }
        if (error instanceof WorkspaceFacadeError) return error;
        const message = error instanceof Error ? error.message : 'workspace operation failed';
        const cause = error instanceof Error ? error : undefined;
        return new WorkspaceFacadeError(message, operation, provider, cause);
    }

    private async resolveTypedPlugin(facadeOptions: FacadeOptions): Promise<IWorkspacePlugin> {
        const plugin: IPlugin = await this.resolvePlugin(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );
        if (!isWorkspacePlugin(plugin)) {
            throw new WorkspaceFacadeError(
                `Plugin ${plugin.id} does not implement the workspace contract.`,
                'resolve',
                plugin.id,
            );
        }
        return plugin;
    }
}
