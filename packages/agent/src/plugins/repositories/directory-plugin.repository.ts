import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DirectoryPluginEntity } from '../entities/directory-plugin.entity';
import {
    addActiveCapability,
    hasActiveCapability,
    removeActiveCapability,
} from '../utils/active-capabilities.util';

/**
 * Repository for managing DirectoryPluginEntity persistence.
 * Handles directory-specific plugin settings and capability assignments.
 */
@Injectable()
export class DirectoryPluginRepository {
    constructor(
        @InjectRepository(DirectoryPluginEntity)
        private readonly repository: Repository<DirectoryPluginEntity>,
    ) {}

    /**
     * Create a new directory plugin record
     */
    async create(data: Partial<DirectoryPluginEntity>): Promise<DirectoryPluginEntity> {
        const dirPlugin = this.repository.create(data);
        return this.repository.save(dirPlugin);
    }

    /**
     * Find a directory plugin by directory ID and plugin ID
     */
    async findByDirectoryAndPlugin(
        directoryId: string,
        pluginId: string,
    ): Promise<DirectoryPluginEntity | null> {
        return this.repository.findOne({
            where: { directoryId, pluginId },
            relations: ['pluginEntity'],
        });
    }

    /**
     * Find by database ID
     */
    async findById(id: string): Promise<DirectoryPluginEntity | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['pluginEntity'],
        });
    }

    /**
     * Find all plugins for a directory
     */
    async findByDirectory(directoryId: string): Promise<DirectoryPluginEntity[]> {
        return this.repository.find({
            where: { directoryId },
            relations: ['pluginEntity'],
            order: { priority: 'ASC', createdAt: 'DESC' },
        });
    }

    /**
     * Find all enabled plugins for a directory
     */
    async findEnabledByDirectory(directoryId: string): Promise<DirectoryPluginEntity[]> {
        return this.repository.find({
            where: { directoryId, enabled: true },
            relations: ['pluginEntity'],
            order: { priority: 'ASC' },
        });
    }

    /**
     * Find the active plugin for a specific capability in a directory
     */
    async findActiveByCapability(
        directoryId: string,
        capability: string,
    ): Promise<DirectoryPluginEntity | null> {
        const directoryPlugins = await this.repository.find({
            where: { directoryId, enabled: true },
            relations: ['pluginEntity'],
        });
        return (
            directoryPlugins.find((directoryPlugin) =>
                hasActiveCapability(directoryPlugin, capability),
            ) ?? null
        );
    }

    /**
     * Find all directory records for a specific plugin
     */
    async findByPlugin(pluginId: string): Promise<DirectoryPluginEntity[]> {
        return this.repository.find({
            where: { pluginId },
            relations: ['directory'],
        });
    }

    /**
     * Find all enabled directory-plugin records for a specific plugin
     */
    async findEnabledByPlugin(pluginId: string): Promise<DirectoryPluginEntity[]> {
        return this.repository.find({
            where: { pluginId, enabled: true },
        });
    }

    /**
     * Update directory plugin settings
     */
    async update(
        id: string,
        data: Partial<DirectoryPluginEntity>,
    ): Promise<DirectoryPluginEntity | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    /**
     * Update directory plugin by directory ID and plugin ID
     */
    async updateByDirectoryAndPlugin(
        directoryId: string,
        pluginId: string,
        data: Partial<DirectoryPluginEntity>,
    ): Promise<DirectoryPluginEntity | null> {
        await this.repository.update({ directoryId, pluginId }, data);
        return this.findByDirectoryAndPlugin(directoryId, pluginId);
    }

    /**
     * Update directory-specific settings
     */
    async updateSettings(
        directoryId: string,
        pluginId: string,
        settings: Record<string, unknown>,
        secretSettings?: Record<string, unknown>,
    ): Promise<DirectoryPluginEntity | null> {
        const updateData: Partial<DirectoryPluginEntity> = { settings };
        if (secretSettings !== undefined) {
            updateData.secretSettings = secretSettings;
        }
        return this.updateByDirectoryAndPlugin(directoryId, pluginId, updateData);
    }

    /**
     * Set the active capability for a plugin in a directory
     */
    async setActiveCapability(
        directoryId: string,
        pluginId: string,
        capability: string | null,
    ): Promise<DirectoryPluginEntity | null> {
        const existing = await this.findByDirectoryAndPlugin(directoryId, pluginId);
        if (!existing) return null;

        if (capability === null) {
            return this.updateByDirectoryAndPlugin(directoryId, pluginId, {
                activeCapabilities: [],
            });
        }

        return this.updateByDirectoryAndPlugin(directoryId, pluginId, {
            activeCapabilities: addActiveCapability(existing, capability),
        });
    }

    /**
     * Clear the active capability from all plugins for a directory (for a specific capability)
     * This is used before setting a new active plugin for a capability.
     */
    async clearActiveCapability(directoryId: string, capability: string): Promise<number> {
        const directoryPlugins = await this.repository.find({
            where: { directoryId },
        });

        const affectedPlugins = directoryPlugins.filter((directoryPlugin) =>
            hasActiveCapability(directoryPlugin, capability),
        );

        await Promise.all(
            affectedPlugins.map((directoryPlugin) => {
                directoryPlugin.activeCapabilities = removeActiveCapability(
                    directoryPlugin,
                    capability,
                );
                return this.repository.save(directoryPlugin);
            }),
        );

        return affectedPlugins.length;
    }

    /**
     * Set a plugin as the active provider for a capability in a directory
     * This clears any existing active plugin for that capability first.
     */
    async setAsActiveForCapability(
        directoryId: string,
        pluginId: string,
        capability: string,
    ): Promise<DirectoryPluginEntity | null> {
        // Clear existing active plugin for this capability
        await this.clearActiveCapability(directoryId, capability);
        // Set the new active plugin
        return this.setActiveCapability(directoryId, pluginId, capability);
    }

    /**
     * Enable or disable a plugin for a directory
     */
    async setEnabled(directoryId: string, pluginId: string, enabled: boolean): Promise<boolean> {
        const result = await this.repository.update({ directoryId, pluginId }, { enabled });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Update plugin priority in a directory
     */
    async setPriority(directoryId: string, pluginId: string, priority: number): Promise<boolean> {
        const result = await this.repository.update({ directoryId, pluginId }, { priority });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete a directory plugin record
     */
    async delete(id: string): Promise<boolean> {
        const result = await this.repository.delete(id);
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete by directory ID and plugin ID
     */
    async deleteByDirectoryAndPlugin(directoryId: string, pluginId: string): Promise<boolean> {
        const result = await this.repository.delete({ directoryId, pluginId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete all directory plugins for a specific directory
     */
    async deleteByDirectory(directoryId: string): Promise<number> {
        const result = await this.repository.delete({ directoryId });
        return result.affected ?? 0;
    }

    /**
     * Delete all directory plugins for a specific plugin
     */
    async deleteByPlugin(pluginId: string): Promise<number> {
        const result = await this.repository.delete({ pluginId });
        return result.affected ?? 0;
    }

    /**
     * Check if a directory has a plugin record
     */
    async exists(directoryId: string, pluginId: string): Promise<boolean> {
        const count = await this.repository.count({ where: { directoryId, pluginId } });
        return count > 0;
    }

    /**
     * Create or update a directory plugin (upsert)
     */
    async upsert(
        data: Partial<DirectoryPluginEntity> & { directoryId: string; pluginId: string },
    ): Promise<DirectoryPluginEntity> {
        const existing = await this.findByDirectoryAndPlugin(data.directoryId, data.pluginId);
        if (existing) {
            await this.repository.update(
                { directoryId: data.directoryId, pluginId: data.pluginId },
                data,
            );
            return this.findByDirectoryAndPlugin(data.directoryId, data.pluginId);
        }
        return this.create(data);
    }
}
