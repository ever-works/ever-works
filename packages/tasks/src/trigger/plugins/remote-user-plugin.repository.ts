import { Injectable } from '@nestjs/common';
import type { PluginSnapshotEntry } from '../trigger-internal-api.client';

/**
 * Stub entity matching the shape of UserPluginEntity for in-memory use.
 */
export interface RemoteUserPluginEntity {
    id: string;
    userId: string;
    pluginEntityId: string;
    pluginId: string;
    enabled: boolean;
    settings: Record<string, unknown>;
    secretSettings: Record<string, unknown>;
    metadata: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * In-memory substitute for UserPluginRepository used in Trigger.dev context.
 * Serves cached user-level plugin data fetched from the API at task start.
 */
@Injectable()
export class RemoteUserPluginRepository {
    private readonly data = new Map<string, RemoteUserPluginEntity>();

    /**
     * Hydrate the repository with snapshot data from the API.
     */
    hydrate(userId: string, plugins: Record<string, PluginSnapshotEntry>): void {
        this.data.clear();
        for (const [pluginId, entry] of Object.entries(plugins)) {
            // Only create an entry if the user has a record (userEnabled !== null)
            if (entry.userEnabled !== null) {
                const key = `${userId}:${pluginId}`;
                this.data.set(key, {
                    id: key,
                    userId,
                    pluginEntityId: pluginId,
                    pluginId,
                    enabled: entry.userEnabled,
                    settings: entry.userSettings,
                    secretSettings: entry.userSecretSettings,
                    metadata: {},
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }
        }
    }

    /**
     * Used by PluginSettingsService and PluginRegistryService.isPluginEnabledForScope()
     */
    async findByUserAndPlugin(
        userId: string,
        pluginId: string,
    ): Promise<RemoteUserPluginEntity | null> {
        return this.data.get(`${userId}:${pluginId}`) ?? null;
    }

    async findByUser(userId: string): Promise<RemoteUserPluginEntity[]> {
        return Array.from(this.data.values()).filter((e) => e.userId === userId);
    }

    async findEnabledByUser(userId: string): Promise<RemoteUserPluginEntity[]> {
        return Array.from(this.data.values()).filter((e) => e.userId === userId && e.enabled);
    }
}
