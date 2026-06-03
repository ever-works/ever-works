import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { PluginEntity, type PluginInstallState } from '../entities/plugin.entity';
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
        category?: PluginCategory;
        state?: PluginState;
        builtIn?: boolean;
    }): Promise<PluginEntity[]> {
        const where: Record<string, unknown> = {};

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

    /**
     * EW-693 — transition a plugin's INSTALL lifecycle (distinct from
     * the load `state` updated by {@link updateState}).
     *
     * Used by the runtime installer to record progress through
     * `available → installing → installed | error`. The optional
     * `details` payload pins the install metadata so a fresh replica
     * can reconcile from the DB:
     * - `registrySpec`: the exact npm spec resolved.
     * - `installedVersion`: the version actually on disk now.
     * - `integrity`: sha512 used to verify the install (FR-10).
     * - `installError`: cleared on success, recorded on error.
     *
     * Behaviour pinned by tests:
     * - When transitioning to `'error'` the installer is expected to
     *   pass `details.installError` — passing `undefined` here will
     *   NOT clear an existing error (use an empty string `''` for that).
     * - When transitioning to `'installed'` the installer is expected
     *   to pass `installedVersion` + `integrity`. The repository does
     *   not synthesise either — it's a thin pass-through.
     */
    async updateInstallState(
        pluginId: string,
        installState: PluginInstallState,
        details?: {
            registrySpec?: string | null;
            installedVersion?: string | null;
            integrity?: string | null;
            installError?: string | null;
            source?: 'bundled' | 'registry';
        }
    ): Promise<PluginEntity | null> {
        const updateData: Partial<PluginEntity> = { installState };
        if (details?.registrySpec !== undefined) {
            updateData.registrySpec = details.registrySpec;
        }
        if (details?.installedVersion !== undefined) {
            updateData.installedVersion = details.installedVersion;
        }
        if (details?.integrity !== undefined) {
            updateData.integrity = details.integrity;
        }
        if (details?.installError !== undefined) {
            updateData.installError = details.installError;
        }
        if (details?.source !== undefined) {
            updateData.source = details.source;
        }
        return this.updateByPluginId(pluginId, updateData);
    }

    /**
     * EW-693 — list plugins by install state. Used by:
     * - the boot reconciler to find `installed`/`installing` rows
     *   that need warmup on a fresh replica;
     * - the admin UI to surface plugins stuck in `error`.
     */
    async findByInstallState(installState: PluginInstallState): Promise<PluginEntity[]> {
        return this.repository.find({
            where: { installState },
            order: { name: 'ASC' }
        });
    }
}
