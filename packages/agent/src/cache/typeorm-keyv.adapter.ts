import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { LessThan, Like, Repository } from 'typeorm';
import { CacheEntry } from '../entities/cache.entity';

export interface TypeORMKeyvOptions {
    repository: Repository<CacheEntry>;
    ttl?: number;
    namespace?: string;
}

/**
 * Keyv-shaped adapter that persists cache entries to the platform's TypeORM
 * `cache` table (see {@link CacheEntry}). Lets the same cache façade work in
 * dev (in-memory keyv) and prod (Postgres-backed) without code changes.
 *
 * Behaviour worth knowing:
 * - **Namespaced by default.** Every key is stored under `${namespace}:${key}`
 *   so multiple cache consumers can share the same `cache` table without
 *   colliding. `namespace` defaults to `'app-cache'`. `get`, `set`, `delete`,
 *   `has`, `clear`, and `deleteMany` all respect the namespace prefix.
 * - **Lazy expiration on read.** `get()` checks `expiresAt` and deletes the
 *   row inline if it's expired, returning `undefined`. No background sweeper
 *   is required — call {@link TypeORMKeyvAdapter.cleanExpired} from a cron
 *   if you also want proactive cleanup.
 * - **`deleteUnscopedEntriesLike` is a footgun.** It runs a LIKE query
 *   against the raw `key` column with no namespace prefix, so it can match
 *   entries belonging to other consumers. Reserved for tenant-wide
 *   invalidation. Pass a sufficiently distinctive `likeTerm` (typically a
 *   tenant or work id, not a short common substring).
 * - **Errors are swallowed and emitted.** Every method catches its DB error,
 *   emits `'error'` on the EventEmitter, and returns the "absent" answer
 *   (`undefined` / `false` / `0`). The caller never sees a thrown error.
 * - `opts.ttl` is typed `any` because the Keyv interface expects an open
 *   bag here; the constructor only reads `options.ttl`.
 */
export class TypeORMKeyvAdapter extends EventEmitter {
    /**
     * Security: app-level bound on caller-supplied key length. The
     * `cache_entries.key` column is an unbounded varchar, so without a
     * guard a caller that builds keys from external input (e.g. the
     * plugin cache facade's `plugin:<id>:<key>` keys) could pollute the
     * shared key namespace with arbitrarily large keys. Keys longer than
     * this are deterministically rewritten to
     * `<first 128 chars>:sha256:<hex digest of the full key>` so they
     * stay readable, bounded, and collision-distinct. Applied inside
     * {@link createKey}, which every read/write/delete/has path goes
     * through, so get/set/delete round-trips keep working and all
     * existing short keys are stored byte-for-byte unchanged.
     */
    private static readonly MAX_KEY_LENGTH = 512;
    private static readonly LONG_KEY_PREFIX_LENGTH = 128;

    private repository: Repository<CacheEntry>;
    public _namespace: string;

    opts: any = {};

    constructor(options: TypeORMKeyvOptions) {
        super();
        this.repository = options.repository;
        this.opts.ttl = options.ttl;
        this._namespace = options.namespace || 'app-cache';
    }

    private normalizeKey(key: string): string {
        if (key.length <= TypeORMKeyvAdapter.MAX_KEY_LENGTH) {
            return key;
        }

        const digest = createHash('sha256').update(key).digest('hex');
        return `${key.slice(0, TypeORMKeyvAdapter.LONG_KEY_PREFIX_LENGTH)}:sha256:${digest}`;
    }

    private createKey(key: string): string {
        return `${this._namespace}:${this.normalizeKey(key)}`;
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
                key: Like(`${this._namespace}:%`),
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

    async deleteUnscopedEntriesLike(likeTerm: string): Promise<void> {
        // Security: refuse an empty/whitespace-only term. Because this runs an
        // un-namespaced `LIKE '%term%'`, a blank term degenerates to `LIKE '%%'`
        // which matches every row and would wipe the entire cache table across
        // all namespaces/tenants. Emit (rather than throw) to match this class's
        // swallow-and-emit error contract; callers see no behaviour change.
        if (typeof likeTerm !== 'string' || likeTerm.trim().length === 0) {
            this.emit(
                'error',
                new Error('deleteUnscopedEntriesLike: likeTerm must be a non-empty string'),
            );
            return;
        }
        try {
            await this.repository.delete({ key: Like(`%${likeTerm}%`) });
        } catch (error) {
            this.emit('error', error);
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
