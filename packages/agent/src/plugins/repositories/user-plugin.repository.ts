import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPluginEntity } from '../entities/user-plugin.entity';

/**
 * Repository for managing UserPluginEntity persistence.
 * Handles user-specific plugin settings and state overrides.
 */
@Injectable()
export class UserPluginRepository {
    constructor(
        @InjectRepository(UserPluginEntity)
        private readonly repository: Repository<UserPluginEntity>,
    ) {}

    /**
     * Create a new user plugin record
     */
    async create(data: Partial<UserPluginEntity>): Promise<UserPluginEntity> {
        const userPlugin = this.repository.create(data);
        return this.repository.save(userPlugin);
    }

    /**
     * Find a user plugin by user ID and plugin ID
     */
    async findByUserAndPlugin(userId: string, pluginId: string): Promise<UserPluginEntity | null> {
        return this.repository.findOne({
            where: { userId, pluginId },
            relations: ['pluginEntity'],
        });
    }

    /**
     * Find by database ID
     */
    async findById(id: string): Promise<UserPluginEntity | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['pluginEntity'],
        });
    }

    /**
     * Find all plugins for a user
     */
    async findByUser(userId: string): Promise<UserPluginEntity[]> {
        return this.repository.find({
            where: { userId },
            relations: ['pluginEntity'],
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Find all enabled plugins for a user
     */
    async findEnabledByUser(userId: string): Promise<UserPluginEntity[]> {
        return this.repository.find({
            where: { userId, enabled: true },
            relations: ['pluginEntity'],
        });
    }

    /**
     * Find all user records for a specific plugin
     */
    async findByPlugin(pluginId: string): Promise<UserPluginEntity[]> {
        return this.repository.find({
            where: { pluginId },
            relations: ['user'],
        });
    }

    /**
     * Update user plugin settings
     */
    async update(id: string, data: Partial<UserPluginEntity>): Promise<UserPluginEntity | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    /**
     * Update user plugin by user ID and plugin ID
     */
    async updateByUserAndPlugin(
        userId: string,
        pluginId: string,
        data: Partial<UserPluginEntity>,
    ): Promise<UserPluginEntity | null> {
        await this.repository.update({ userId, pluginId }, data);
        return this.findByUserAndPlugin(userId, pluginId);
    }

    /**
     * Update user-specific settings
     */
    async updateSettings(
        userId: string,
        pluginId: string,
        settings: Record<string, unknown>,
        secretSettings?: Record<string, unknown>,
    ): Promise<UserPluginEntity | null> {
        const updateData: Partial<UserPluginEntity> = { settings };
        if (secretSettings !== undefined) {
            updateData.secretSettings = secretSettings;
        }
        return this.updateByUserAndPlugin(userId, pluginId, updateData);
    }

    /**
     * Enable or disable a plugin for a user
     */
    async setEnabled(userId: string, pluginId: string, enabled: boolean): Promise<boolean> {
        const result = await this.repository.update({ userId, pluginId }, { enabled });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete a user plugin record
     */
    async delete(id: string): Promise<boolean> {
        const result = await this.repository.delete(id);
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete by user ID and plugin ID
     */
    async deleteByUserAndPlugin(userId: string, pluginId: string): Promise<boolean> {
        const result = await this.repository.delete({ userId, pluginId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Delete all user plugins for a specific plugin
     */
    async deleteByPlugin(pluginId: string): Promise<number> {
        const result = await this.repository.delete({ pluginId });
        return result.affected ?? 0;
    }

    /**
     * Check if a user has a plugin record
     */
    async exists(userId: string, pluginId: string): Promise<boolean> {
        const count = await this.repository.count({ where: { userId, pluginId } });
        return count > 0;
    }

    /**
     * Create or update a user plugin (upsert)
     */
    async upsert(
        data: Partial<UserPluginEntity> & { userId: string; pluginId: string },
    ): Promise<UserPluginEntity> {
        const existing = await this.findByUserAndPlugin(data.userId, data.pluginId);
        if (existing) {
            await this.repository.update({ userId: data.userId, pluginId: data.pluginId }, data);
            return this.findByUserAndPlugin(data.userId, data.pluginId);
        }
        return this.create(data);
    }
}
