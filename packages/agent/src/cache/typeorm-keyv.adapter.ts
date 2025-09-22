import { EventEmitter } from 'events';
import { LessThan, Like, Repository } from 'typeorm';
import { CacheEntry } from '../entities/cache.entity';

export interface TypeORMKeyvOptions {
    repository: Repository<CacheEntry>;
    namespace?: string;
}

export class TypeORMKeyvAdapter extends EventEmitter {
    private repository: Repository<CacheEntry>;
    public namespace: string;

    opts: any = {};

    constructor(options: TypeORMKeyvOptions) {
        super();
        this.repository = options.repository;
        this.namespace = options.namespace || 'cache';
    }

    private createKey(key: string): string {
        return `${this.namespace}:${key}`;
    }

    async get(key: string): Promise<any> {
        try {
            const fullKey = this.createKey(key);
            const entry = await this.repository.findOne({ where: { key: fullKey } });

            if (!entry) {
                return undefined;
            }

            // Check if the entry has expired
            if (entry.expiresAt && Date.now() > entry.expiresAt) {
                await this.delete(key);
                return undefined;
            }

            return JSON.parse(entry.value);
        } catch (error) {
            this.emit('error', error);
            return undefined;
        }
    }

    async set(key: string, value: any, ttl?: number): Promise<any> {
        try {
            const fullKey = this.createKey(key);
            const expiresAt = ttl ? Date.now() + ttl : null;

            await this.repository.upsert(
                { key: fullKey, value: JSON.stringify(value), expiresAt },
                ['key'],
            );

            return true;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    async delete(key: string): Promise<boolean> {
        try {
            const fullKey = this.createKey(key);
            const result = await this.repository.delete({ key: fullKey });
            return result.affected > 0;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    async clear(): Promise<void> {
        try {
            await this.repository.delete({
                key: Like(`${this.namespace}:%`),
            });
        } catch (error) {
            this.emit('error', error);
        }
    }

    async has(key: string): Promise<boolean> {
        try {
            const fullKey = this.createKey(key);
            const count = await this.repository.count({ where: { key: fullKey } });
            return count > 0;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    // Clean up expired entries
    async cleanExpired(): Promise<number> {
        try {
            const result = await this.repository.delete({
                expiresAt: LessThan(Date.now()),
            });

            return result.affected || 0;
        } catch (error) {
            this.emit('error', error);
            return 0;
        }
    }

    deleteMany?(key: string[]): Promise<boolean> {
        return Promise.all(key.map((k) => this.delete(k))).then((results) => {
            return results.every((r) => r);
        });
    }

    disconnect?(): Promise<void> {
        return Promise.resolve();
    }
}
