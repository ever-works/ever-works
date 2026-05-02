import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkPluginEntity } from '../entities/work-plugin.entity';
import {
    addActiveCapability,
    hasActiveCapability,
    removeActiveCapability,
} from '../utils/active-capabilities.util';

/**
 * Repository for managing WorkPluginEntity persistence.
 * Handles work-specific plugin settings and capability assignments.
 */
@Injectable()
export class WorkPluginRepository {
    constructor(
        @InjectRepository(WorkPluginEntity)
        private readonly repository: Repository<WorkPluginEntity>,
    ) {}

    /**
     * Create a new work plugin record
     */
    async create(data: Partial<WorkPluginEntity>): Promise<WorkPluginEntity> {
        const dirPlugin = this.repository.create(data);
        return this.repository.save(dirPlugin);
    }

    /**
     * Find a work plugin by work ID and plugin ID
     */
    async findByWorkAndPlugin(
        workId: string,
        pluginId: string,
    ): Promise<WorkPluginEntity | null> {
        return this.repository.findOne({
            where: { workId, pluginId },
            relations: ['pluginEntity'],
        });
    }

    /**
     * Find by database ID
     */
    async findById(id: string): Promise<WorkPluginEntity | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['pluginEntity'],
        });
    }

    /**
     * Find all plugins for a work
     */
    async findByWork(workId: string): Promise<WorkPluginEntity[]> {
        return this.repository.find({
            where: { workId },
            relations: ['pluginEntity'],
            order: { priority: 'ASC', createdAt: 'DESC' },
        });
    }

    /**
     * Find all enabled plugins for a work
     */
    async findEnabledByWork(workId: string): Promise<WorkPluginEntity[]> {
        return this.repository.find({
            where: { workId, enabled: true },
            relations: ['pluginEntity'],
            order: { priority: 'ASC' },
        });
    }

    /**
     * Find the active plugin for a specific capability in a work
     */
    async findActiveByCapability(
        workId: string,
        capability: string,
    ): Promise<WorkPluginEntity | null> {
        const workPlugins = await this.repository.find({
            where: { workId, enabled: true },
            relations: ['pluginEntity'],
        });
        return (
            workPlugins.find((workPlugin) =>
                hasActiveCapability(workPlugin, capability),
            ) ?? null
        );
    }

    /**
     * Find all work records for a specific plugin
     */
    async findByPlugin(pluginId: string): Promise<WorkPluginEntity[]> {
        return this.repository.find({
            where: { pluginId },
            relations: ['work'],
        });
    }

    /**
     * Find all enabled work-plugin records for a specific plugin
     */
    async findEnabledByPlugin(pluginId: string): Promise<WorkPluginEntity[]> {
        return this.repository.find({
            where: { pluginId, enabled: true },
        });
    }

    /**
     * Update work plugin settings
     */
    async update(
        id: string,
        data: Partial<WorkPluginEntity>,
    ): Promise<WorkPluginEntity | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    /**
     * Update work plugin by work ID and plugin ID
     */
    async updateByWorkAndPlugin(
        workId: string,
        pluginId: string,
        data: Partial<WorkPluginEntity>,
    ): Promise<WorkPluginEntity | null> {
        await this.repository.update({ workId, pluginId }, data);
        return this.findByWorkAndPlugin(workId, pluginId);
    }

    /**
     * Update work-specific settings
     */
    async updateSettings(
        workId: string,
        pluginId: string,
        settings: Record<string, unknown>,
        secretSettings?: Record<string, unknown>,
    ): Promise<WorkPluginEntity | null> {
        const updateData: Partial<WorkPluginEntity> = { settings };
        if (secretSettings !== undefined) {
            updateData.secretSettings = secretSettings;
        }
        return this.updateByWorkAndPlugin(workId, pluginId, updateData);
    }

    /**
     * Set the active capability for a plugin in a work
     */
    async setActiveCapability(
        workId: string,
        pluginId: string,
        capability: string | null,
    ): Promise<WorkPluginEntity | null> {
        const existing = await this.findByWorkAndPlugin(workId, pluginId);
        if (!existing) return null;

        if (capability === null) {
            return this.updateByWorkAndPlugin(workId, pluginId, {
                activeCapabilities: [],
            });
        }

        return this.updateByWorkAndPlugin(workId, pluginId, {
            activeCapabilities: addActiveCapability(existing, capability),
        });
    }

    /**
     * Clear the active capability from all plugins for a work (for a specific capability)
     * This is used before setting a new active plugin for a capability.
     */
    async clearActiveCapability(workId: string, capability: string): Promise<number> {
        const workPlugins = await this.repository.find({
            where: { workId },
        });

        const affectedPlugins = workPlugins.filter((workPlugin) =>
            hasActiveCapability(workPlugin, capability),
        );

        await Promise.all(
            affectedPlugins.map((workPlugin) => {
                workPlugin.activeCapabilities = removeActiveCapability(
                    workPlugin,
                    capability,
                );
                return this.repository.save(workPlugin);
            }),
        );

        return affectedPlugins.length;
    }

    /**
     * Set a plugin as the active provider for a capability in a work
     * This clears any existing active plugin for that capability first.
     */
    async setAsActiveForCapability(
        workId: string,
        pluginId: string,
        capability: string,
    ): Promise<WorkPluginEntity | null> {
        // Clear existing active plugin for this capability
        await this.clearActiveCapability(workId, capability);
        // Set the new active plugin
        return this.setActiveCapability(workId, pluginId, capability);
    }

    /**
     * Enable or disable a plugin for a work
     */
    async setEnabled(workId: string, pluginId: string, enabled: boolean): Promise<boolean> {
        const result = await this.repository.update({ workId, pluginId }, { enabled });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Update plugin priority in a work
     */
    async setPriority(workId: string, pluginId: string, priority: number): Promise<boolean> {
        const result = await this.repository.update({ workId, pluginId }, { priority });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete a work plugin record
     */
    async delete(id: string): Promise<boolean> {
        const result = await this.repository.delete(id);
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete by work ID and plugin ID
     */
    async deleteByWorkAndPlugin(workId: string, pluginId: string): Promise<boolean> {
        const result = await this.repository.delete({ workId, pluginId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete all work plugins for a specific work
     */
    async deleteByWork(workId: string): Promise<number> {
        const result = await this.repository.delete({ workId });
        return result.affected ?? 0;
    }

    /**
     * Delete all work plugins for a specific plugin
     */
    async deleteByPlugin(pluginId: string): Promise<number> {
        const result = await this.repository.delete({ pluginId });
        return result.affected ?? 0;
    }

    /**
     * Check if a work has a plugin record
     */
    async exists(workId: string, pluginId: string): Promise<boolean> {
        const count = await this.repository.count({ where: { workId, pluginId } });
        return count > 0;
    }

    /**
     * Create or update a work plugin (upsert)
     */
    async upsert(
        data: Partial<WorkPluginEntity> & { workId: string; pluginId: string },
    ): Promise<WorkPluginEntity> {
        const existing = await this.findByWorkAndPlugin(data.workId, data.pluginId);
        if (existing) {
            await this.repository.update(
                { workId: data.workId, pluginId: data.pluginId },
                data,
            );
            return this.findByWorkAndPlugin(data.workId, data.pluginId);
        }
        return this.create(data);
    }
}
