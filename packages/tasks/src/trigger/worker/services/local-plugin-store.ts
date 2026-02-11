/**
 * In-memory store for plugin metadata written during bootstrap.
 * Write methods stay local; reads fall through to the remote proxy.
 */
export class LocalPluginStore {
    private readonly data = new Map<string, Record<string, unknown>>();

    async upsert(data: Record<string, unknown> & { pluginId: string }) {
        const existing = this.data.get(data.pluginId);
        if (existing) {
            Object.assign(existing, data);
            return existing;
        }
        const entity = { id: data.pluginId, ...data };
        this.data.set(data.pluginId, entity);
        return entity;
    }

    async updateState(pluginId: string, state: string, error?: string) {
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
