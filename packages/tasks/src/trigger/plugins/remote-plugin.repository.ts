import { Injectable } from '@nestjs/common';
import type { PluginSnapshotEntry } from '../trigger-internal-api.client';

/**
 * Stub entity matching the shape of PluginEntity for in-memory use.
 * Only fields actually read by PluginSettingsService and PluginLoaderService are populated.
 */
export interface RemotePluginEntity {
    id: string;
    pluginId: string;
    name: string;
    version: string;
    description: string;
    category: string;
    capabilities: string[];
    manifest: Record<string, unknown>;
    configurationMode: string;
    state: string;
    enabled: boolean;
    builtIn: boolean;
    installPath: string;
    settings: Record<string, unknown>;
    secretSettings: Record<string, unknown>;
    lastError: string;
    loadedAt: Date;
    enabledAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * In-memory substitute for PluginRepository used in Trigger.dev context.
 * Serves cached data fetched from the API at task start.
 *
 * Write operations are no-ops since Trigger.dev tasks are read-only for plugin settings.
 */
@Injectable()
export class RemotePluginRepository {
    private readonly data = new Map<string, RemotePluginEntity>();

    /**
     * Hydrate the repository with snapshot data from the API.
     */
    hydrate(plugins: Record<string, PluginSnapshotEntry>): void {
        this.data.clear();
        for (const [pluginId, entry] of Object.entries(plugins)) {
            this.data.set(pluginId, {
                id: pluginId,
                pluginId,
                name: pluginId,
                version: '0.0.0',
                description: '',
                category: 'other',
                capabilities: [],
                manifest: {},
                configurationMode: 'hybrid',
                state: 'enabled',
                enabled: true,
                builtIn: true,
                installPath: '',
                settings: entry.adminSettings,
                secretSettings: entry.adminSecretSettings,
                lastError: '',
                loadedAt: new Date(),
                enabledAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        }
    }

    /**
     * Used by PluginSettingsService.getResolvedSettings() and PluginLifecycleManagerService
     */
    async findByPluginId(pluginId: string): Promise<RemotePluginEntity | null> {
        return this.data.get(pluginId) ?? null;
    }

    /**
     * Called by PluginLoaderService during bootstrap.
     * Returns existing cached entity or creates a stub.
     */
    async upsert(
        data: Partial<RemotePluginEntity> & { pluginId: string },
    ): Promise<RemotePluginEntity> {
        const existing = this.data.get(data.pluginId);
        if (existing) {
            Object.assign(existing, data);
            return existing;
        }
        const entity: RemotePluginEntity = {
            id: data.pluginId,
            pluginId: data.pluginId,
            name: data.name ?? data.pluginId,
            version: data.version ?? '0.0.0',
            description: data.description ?? '',
            category: (data.category as string) ?? 'other',
            capabilities: data.capabilities ?? [],
            manifest: data.manifest ?? {},
            configurationMode: data.configurationMode ?? 'hybrid',
            state: (data.state as string) ?? 'loaded',
            enabled: data.enabled ?? true,
            builtIn: data.builtIn ?? true,
            installPath: data.installPath ?? '',
            settings: data.settings ?? {},
            secretSettings: data.secretSettings ?? {},
            lastError: data.lastError ?? '',
            loadedAt: data.loadedAt ?? new Date(),
            enabledAt: data.enabledAt ?? new Date(),
            createdAt: data.createdAt ?? new Date(),
            updatedAt: data.updatedAt ?? new Date(),
        };
        this.data.set(data.pluginId, entity);
        return entity;
    }

    /**
     * Called by PluginLifecycleManagerService - no-op in remote context.
     */
    async updateState(
        pluginId: string,
        state: string,
        error?: string,
    ): Promise<RemotePluginEntity | null> {
        const entity = this.data.get(pluginId);
        if (entity) {
            entity.state = state;
            if (error !== undefined) {
                entity.lastError = error;
            }
        }
        return entity ?? null;
    }

    /**
     * Called by PluginLifecycleManagerService - returns entity by pluginId update.
     */
    async updateByPluginId(
        pluginId: string,
        data: Partial<RemotePluginEntity>,
    ): Promise<RemotePluginEntity | null> {
        const entity = this.data.get(pluginId);
        if (entity) {
            Object.assign(entity, data);
        }
        return entity ?? null;
    }

    async findAll(): Promise<RemotePluginEntity[]> {
        return Array.from(this.data.values());
    }

    async findEnabled(): Promise<RemotePluginEntity[]> {
        return Array.from(this.data.values()).filter((e) => e.enabled);
    }

    async exists(pluginId: string): Promise<boolean> {
        return this.data.has(pluginId);
    }
}
