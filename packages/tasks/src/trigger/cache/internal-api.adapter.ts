import { EventEmitter } from 'events';
import { TriggerInternalApiClient } from '../trigger-internal-api.client';

export interface InternalAPIOptions {
    apiClient: TriggerInternalApiClient;
    ttl?: number;
}

export class InternalAPIAdapter extends EventEmitter {
    private apiClient: TriggerInternalApiClient;

    opts: any = {};

    constructor(options: InternalAPIOptions) {
        super();
        this.apiClient = options.apiClient;
        this.opts.ttl = options.ttl;
    }

    async get(key: string): Promise<any> {
        try {
            const entry = await this.apiClient.getCacheEntry(key);
            if (!entry) {
                return undefined;
            }

            return entry;
        } catch (error) {
            this.emit('error', error);
            return undefined;
        }
    }

    async set(key: string, value: any, ttl?: number): Promise<any> {
        try {
            await this.apiClient.setCacheEntry(key, value, ttl);

            return true;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    async delete(key: string): Promise<boolean> {
        try {
            return await this.apiClient.deleteCacheEntry(key);
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    async clear(): Promise<void> {
        try {
            // Unsupported operation in this adapter
        } catch (error) {
            this.emit('error', error);
        }
    }

    async has(key: string): Promise<boolean> {
        try {
            const entry = await this.get(key);
            return !!entry;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    // Clean up expired entries
    async cleanExpired(): Promise<number> {
        try {
            // Unsupported operation in this adapter
            return 0;
        } catch (error) {
            this.emit('error', error);
            return 0;
        }
    }

    async deleteUnscopedEntriesLike(likeTerm: string): Promise<void> {
        try {
            // Unsupported operation in this adapter
        } catch (error) {
            this.emit('error', error);
        }
    }

    deleteMany?(key: string[]): Promise<boolean> {
        return Promise.resolve(false);
    }

    disconnect?(): Promise<void> {
        return Promise.resolve();
    }

    wrap<T>(
        key: string,
        fn: () => T | Promise<T>,
        options?: number | { ttl?: number },
    ): Promise<T> {
        const ttl = typeof options === 'number' ? options : options.ttl || this.opts.ttl;

        return this.get(key).then((cachedValue) => {
            if (cachedValue !== undefined) {
                return cachedValue;
            }

            return Promise.resolve(fn()).then((value) => {
                this.set(key, value, ttl);
                return value;
            });
        });
    }
}
