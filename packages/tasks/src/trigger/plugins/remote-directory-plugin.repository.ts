import { Injectable } from '@nestjs/common';
import type { PluginSnapshotEntry } from '../trigger-internal-api.client';

/**
 * Stub entity matching the shape of DirectoryPluginEntity for in-memory use.
 */
export interface RemoteDirectoryPluginEntity {
    id: string;
    directoryId: string;
    pluginEntityId: string;
    pluginId: string;
    enabled: boolean;
    activeCapability: string | null;
    settings: Record<string, unknown>;
    secretSettings: Record<string, unknown>;
    metadata: Record<string, unknown>;
    priority: number;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * In-memory substitute for DirectoryPluginRepository used in Trigger.dev context.
 * Serves cached directory-level plugin data fetched from the API at task start.
 */
@Injectable()
export class RemoteDirectoryPluginRepository {
    private readonly data = new Map<string, RemoteDirectoryPluginEntity>();

    /**
     * Hydrate the repository with snapshot data from the API.
     */
    hydrate(directoryId: string, plugins: Record<string, PluginSnapshotEntry>): void {
        this.data.clear();
        for (const [pluginId, entry] of Object.entries(plugins)) {
            // Only create an entry if the directory has a record (directoryEnabled !== null)
            if (entry.directoryEnabled !== null) {
                const key = `${directoryId}:${pluginId}`;
                this.data.set(key, {
                    id: key,
                    directoryId,
                    pluginEntityId: pluginId,
                    pluginId,
                    enabled: entry.directoryEnabled,
                    activeCapability: entry.directoryActiveCapability,
                    settings: entry.directorySettings,
                    secretSettings: entry.directorySecretSettings,
                    metadata: {},
                    priority: entry.directoryPriority,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }
        }
    }

    /**
     * Used by PluginSettingsService and PluginRegistryService.isPluginEnabledForScope()
     */
    async findByDirectoryAndPlugin(
        directoryId: string,
        pluginId: string,
    ): Promise<RemoteDirectoryPluginEntity | null> {
        return this.data.get(`${directoryId}:${pluginId}`) ?? null;
    }

    /**
     * Used by BaseFacadeService.findActivePluginForDirectory()
     */
    async findActiveByCapability(
        directoryId: string,
        capability: string,
    ): Promise<RemoteDirectoryPluginEntity | null> {
        for (const entity of this.data.values()) {
            if (
                entity.directoryId === directoryId &&
                entity.activeCapability === capability &&
                entity.enabled
            ) {
                return entity;
            }
        }
        return null;
    }

    async findByDirectory(directoryId: string): Promise<RemoteDirectoryPluginEntity[]> {
        return Array.from(this.data.values())
            .filter((e) => e.directoryId === directoryId)
            .sort((a, b) => a.priority - b.priority);
    }

    async findEnabledByDirectory(directoryId: string): Promise<RemoteDirectoryPluginEntity[]> {
        return Array.from(this.data.values())
            .filter((e) => e.directoryId === directoryId && e.enabled)
            .sort((a, b) => a.priority - b.priority);
    }
}
