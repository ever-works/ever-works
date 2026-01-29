import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { PluginEntity } from '../entities/plugin.entity';
import type { PluginCategory, PluginState } from '@ever-works/plugin';

/**
 * Repository for managing PluginEntity persistence.
 * Handles CRUD operations and queries for plugin metadata and state.
 */
@Injectable()
export class PluginRepository {
    constructor(
        @InjectRepository(PluginEntity)
        private readonly repository: Repository<PluginEntity>,
    ) {}

    /**
     * Create a new plugin record
     */
    async create(data: Partial<PluginEntity>): Promise<PluginEntity> {
        const plugin = this.repository.create(data);
        return this.repository.save(plugin);
    }

    /**
     * Find a plugin by its unique plugin ID (e.g., 'github-provider')
     */
    async findByPluginId(pluginId: string): Promise<PluginEntity | null> {
        return this.repository.findOne({ where: { pluginId } });
    }

    /**
     * Find a plugin by database ID
     */
    async findById(id: string): Promise<PluginEntity | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * Find all plugins
     */
    async findAll(options?: {
        enabled?: boolean;
        category?: PluginCategory;
        state?: PluginState;
        builtIn?: boolean;
    }): Promise<PluginEntity[]> {
        const where: Record<string, unknown> = {};

        if (options?.enabled !== undefined) {
            where.enabled = options.enabled;
        }
        if (options?.category) {
            where.category = options.category;
        }
        if (options?.state) {
            where.state = options.state;
        }
        if (options?.builtIn !== undefined) {
            where.builtIn = options.builtIn;
        }

        return this.repository.find({
            where: Object.keys(where).length > 0 ? where : undefined,
            order: { name: 'ASC' },
        });
    }

    /**
     * Find plugins by category
     */
    async findByCategory(category: PluginCategory): Promise<PluginEntity[]> {
        return this.repository.find({
            where: { category },
            order: { name: 'ASC' },
        });
    }

    /**
     * Find plugins that have a specific capability
     */
    async findByCapability(capability: string): Promise<PluginEntity[]> {
        const plugins = await this.repository.find();
        return plugins.filter((p) => p.capabilities.includes(capability));
    }

    /**
     * Find all enabled plugins
     */
    async findEnabled(): Promise<PluginEntity[]> {
        return this.repository.find({
            where: { enabled: true },
            order: { name: 'ASC' },
        });
    }

    /**
     * Find plugins by multiple plugin IDs
     */
    async findByPluginIds(pluginIds: string[]): Promise<PluginEntity[]> {
        if (pluginIds.length === 0) {
            return [];
        }
        return this.repository.find({
            where: { pluginId: In(pluginIds) },
        });
    }

    /**
     * Update a plugin by plugin ID
     */
    async updateByPluginId(
        pluginId: string,
        data: Partial<PluginEntity>,
    ): Promise<PluginEntity | null> {
        await this.repository.update({ pluginId }, data);
        return this.findByPluginId(pluginId);
    }

    /**
     * Update a plugin by database ID
     */
    async update(id: string, data: Partial<PluginEntity>): Promise<PluginEntity | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    /**
     * Update plugin state
     */
    async updateState(
        pluginId: string,
        state: PluginState,
        error?: string,
    ): Promise<PluginEntity | null> {
        const updateData: Partial<PluginEntity> = { state };
        if (error !== undefined) {
            updateData.lastError = error;
        }
        if (state === 'loaded') {
            updateData.loadedAt = new Date();
        }
        if (state === 'enabled') {
            updateData.enabledAt = new Date();
            updateData.enabled = true;
        }
        if (state === 'disabled' || state === 'unloaded') {
            updateData.enabled = false;
        }
        return this.updateByPluginId(pluginId, updateData);
    }

    /**
     * Update plugin settings
     */
    async updateSettings(
        pluginId: string,
        settings: Record<string, unknown>,
        secretSettings?: Record<string, unknown>,
    ): Promise<PluginEntity | null> {
        const updateData: Partial<PluginEntity> = { settings };
        if (secretSettings !== undefined) {
            updateData.secretSettings = secretSettings;
        }
        return this.updateByPluginId(pluginId, updateData);
    }

    /**
     * Delete a plugin by plugin ID
     */
    async deleteByPluginId(pluginId: string): Promise<boolean> {
        const result = await this.repository.delete({ pluginId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete a plugin by database ID
     */
    async delete(id: string): Promise<boolean> {
        const result = await this.repository.delete(id);
        return (result.affected ?? 0) > 0;
    }

    /**
     * Check if a plugin exists by plugin ID
     */
    async exists(pluginId: string): Promise<boolean> {
        const count = await this.repository.count({ where: { pluginId } });
        return count > 0;
    }

    /**
     * Create or update a plugin (upsert by pluginId)
     */
    async upsert(data: Partial<PluginEntity> & { pluginId: string }): Promise<PluginEntity> {
        const existing = await this.findByPluginId(data.pluginId);
        if (existing) {
            await this.repository.update({ pluginId: data.pluginId }, data);
            return this.findByPluginId(data.pluginId);
        }
        return this.create(data);
    }
}
