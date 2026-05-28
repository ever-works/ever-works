import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IAgentMemoryPlugin,
    IAgentMemoryFacade,
    AgentMemorySession,
    AgentMemoryRecord,
    AgentMemorySearchResponse,
    AgentMemoryContext,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class AgentMemoryFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'AgentMemoryFacadeError';
    }
}

/**
 * Facade for the `agent-memory` capability.
 *
 * Routes save/search/context/session operations to the user's resolved
 * agent-memory plugin (default `@ever-works/agentmemory-plugin`, which
 * talks to a local or hosted `agentmemory` REST server).
 *
 * Mirrors the other facades: provider resolution + 4-level settings
 * hierarchy via `BaseFacadeService`. Optional governance methods
 * (`deleteEntry`, `listSessions`) probe the resolved plugin for support
 * before dispatching — community plugins MAY skip them.
 */
@Injectable()
export class AgentMemoryFacadeService extends BaseFacadeService implements IAgentMemoryFacade {
    protected readonly logger = new Logger(AgentMemoryFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.AGENT_MEMORY;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    async openSession(
        metadata: Record<string, unknown> | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemorySession> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.openSession({
                metadata,
                settings,
            });
        } catch (error) {
            throw this.wrap(error, 'openSession', plugin.id);
        }
    }

    async closeSession(sessionId: string, facadeOptions: FacadeOptions): Promise<void> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            await plugin.closeSession(sessionId, settings);
        } catch (error) {
            throw this.wrap(error, 'closeSession', plugin.id);
        }
    }

    async saveMemory(
        input: {
            content: string;
            tags?: readonly string[];
            metadata?: Record<string, unknown>;
            sessionId?: string;
            projectId?: string;
        },
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemoryRecord> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.saveMemory({ ...input, settings });
        } catch (error) {
            throw this.wrap(error, 'saveMemory', plugin.id);
        }
    }

    async searchMemory(
        input: {
            query: string;
            limit?: number;
            tags?: readonly string[];
            sessionId?: string;
            projectId?: string;
        },
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemorySearchResponse> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.searchMemory({ ...input, settings });
        } catch (error) {
            throw this.wrap(error, 'searchMemory', plugin.id);
        }
    }

    async buildContext(
        input: {
            query?: string;
            purpose?: string;
            sessionId?: string;
            projectId?: string;
            maxTokens?: number;
        },
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemoryContext> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.buildContext({ ...input, settings });
        } catch (error) {
            throw this.wrap(error, 'buildContext', plugin.id);
        }
    }

    async deleteEntry(id: string, facadeOptions: FacadeOptions): Promise<void> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        if (typeof plugin.deleteEntry !== 'function') {
            throw new AgentMemoryFacadeError(
                `Agent-memory provider "${plugin.providerName}" does not support deleteEntry`,
                'deleteEntry',
                plugin.id,
            );
        }
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            await plugin.deleteEntry(id, settings);
        } catch (error) {
            throw this.wrap(error, 'deleteEntry', plugin.id);
        }
    }

    async listSessions(
        options: { limit?: number; projectId?: string } | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<readonly AgentMemorySession[]> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        if (typeof plugin.listSessions !== 'function') {
            throw new AgentMemoryFacadeError(
                `Agent-memory provider "${plugin.providerName}" does not support listSessions`,
                'listSessions',
                plugin.id,
            );
        }
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.listSessions({ ...options, settings });
        } catch (error) {
            throw this.wrap(error, 'listSessions', plugin.id);
        }
    }

    private resolveTypedPlugin(facadeOptions: FacadeOptions): Promise<IAgentMemoryPlugin> {
        return this.resolvePlugin<IAgentMemoryPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );
    }

    private wrap(error: unknown, operation: string, provider: string): AgentMemoryFacadeError {
        if (error instanceof AgentMemoryFacadeError) return error;
        const message = error instanceof Error ? error.message : 'Agent-memory operation failed';
        const cause = error instanceof Error ? error : undefined;
        return new AgentMemoryFacadeError(message, operation, provider, cause);
    }
}
