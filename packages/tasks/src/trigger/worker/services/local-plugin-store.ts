import { PluginEntity, PluginRepository } from '@ever-works/agent/plugins';

/**
 * In-memory store for plugin metadata written during bootstrap.
 * Write methods stay local; reads fall through to the remote proxy.
 */
export class LocalPluginStore implements Omit<
    PluginRepository,
    | 'findById'
    | 'findByPluginId'
    | 'findAll'
    | 'findByCategory'
    | 'findByCapability'
    | 'findByPluginIds'
    | 'updateSettings'
> {
    private readonly data = new Map<string, PluginEntity>();

    async create(data: Partial<PluginEntity>): Promise<PluginEntity> {
        const entity = { id: data.pluginId!, ...data } as PluginEntity;
        this.data.set(data.pluginId!, entity);
        return entity;
    }

    async upsert(data: Partial<PluginEntity> & { pluginId: string }): Promise<PluginEntity> {
        const existing = this.data.get(data.pluginId);
        if (existing) {
            Object.assign(existing, data);
            return existing;
        }
        const entity = { id: data.pluginId, ...data };
        this.data.set(data.pluginId, entity as PluginEntity);
        return entity as PluginEntity;
    }

    update(id: string, data: Partial<PluginEntity>): Promise<PluginEntity | null> {
        const entity = this.data.get(id);
        if (!entity) {
            return Promise.resolve(null);
        }
        Object.assign(entity, data);
        return Promise.resolve(entity);
    }

    deleteByPluginId(pluginId: string): Promise<boolean> {
        return Promise.resolve(this.data.delete(pluginId));
    }

    delete(id: string): Promise<boolean> {
        return Promise.resolve(this.data.delete(id));
    }

    async updateState(pluginId: string, state: any, error?: string): Promise<PluginEntity | null> {
        const entity = this.data.get(pluginId);
        if (entity) {
            entity.state = state;
            if (error !== undefined) entity.lastError = error;
        }
        return entity ?? null;
    }

    async updateByPluginId(pluginId: string, data: Record<string, unknown>) {
        const entity = this.data.get(pluginId);
        if (entity) Object.assign(entity, data);
        return entity ?? null;
    }

    async exists(pluginId: string) {
        return this.data.has(pluginId);
    }

    async findAll() {
        return Array.from(this.data.values());
    }

    async findEnabled() {
        return Array.from(this.data.values()).filter((e: any) => e.enabled);
    }
}
