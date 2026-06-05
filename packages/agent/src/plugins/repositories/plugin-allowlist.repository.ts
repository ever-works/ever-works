import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginAllowlistEntity } from '../entities/plugin-allowlist.entity';

/**
 * Repository for `plugin_allowlist` (EW-693).
 *
 * Backs the admin allowlist surface: list / create / update / delete
 * entries and the installer's per-install permission check
 * (`findByPackageName`). First-party `@ever-works/*` is NOT stored in
 * the allowlist — those packages are implicitly permitted by the
 * installer and never query this table.
 *
 * Mirrors the shape of `PluginRepository`: a thin TypeORM wrapper with
 * predictable single-purpose methods, no business logic.
 */
@Injectable()
export class PluginAllowlistRepository {
    constructor(
        @InjectRepository(PluginAllowlistEntity)
        private readonly repository: Repository<PluginAllowlistEntity>,
    ) {}

    /**
     * List all allowlist entries (enabled + disabled).
     * Ordered alphabetically for the admin UI.
     */
    async findAll(): Promise<PluginAllowlistEntity[]> {
        return this.repository.find({ order: { packageName: 'ASC' } });
    }

    /**
     * List only the enabled entries. The installer's allow-check should
     * always use this — a disabled row must behave as if absent.
     */
    async findEnabled(): Promise<PluginAllowlistEntity[]> {
        return this.repository.find({
            where: { enabled: true },
            order: { packageName: 'ASC' },
        });
    }

    /**
     * Look up a single entry by npm package name. Returns null when
     * absent — callers MUST treat null as "not permitted" rather than
     * falling back to allow.
     */
    async findByPackageName(packageName: string): Promise<PluginAllowlistEntity | null> {
        return this.repository.findOne({ where: { packageName } });
    }

    async findById(id: string): Promise<PluginAllowlistEntity | null> {
        return this.repository.findOne({ where: { id } });
    }

    async create(data: Partial<PluginAllowlistEntity>): Promise<PluginAllowlistEntity> {
        const entry = this.repository.create(data);
        return this.repository.save(entry);
    }

    async update(
        id: string,
        data: Partial<PluginAllowlistEntity>,
    ): Promise<PluginAllowlistEntity | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    async deleteById(id: string): Promise<boolean> {
        const result = await this.repository.delete(id);
        return (result.affected ?? 0) > 0;
    }

    /**
     * Toggle the `enabled` flag in-place. Convenience helper for the
     * admin UI's toggle column.
     */
    async setEnabled(id: string, enabled: boolean): Promise<PluginAllowlistEntity | null> {
        return this.update(id, { enabled });
    }
}
