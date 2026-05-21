import { Logger } from '@nestjs/common';
import type { IStoragePlugin, PluginContext, PluginLogger } from '@ever-works/plugin';
import { LocalFsStoragePlugin } from '@ever-works/local-fs-plugin';

/**
 * EW-637 — selects + lazily instantiates the active storage backend.
 *
 * `STORAGE_BACKEND` env (case-insensitive):
 *   - `local-fs` (default) — disk under `UPLOADS_DIR`. Bundled.
 *   - `aws-s3`             — S3 bucket. Requires the optional dep
 *                            `@ever-works/aws-s3-plugin` to be installed.
 *   - `minio`              — MinIO endpoint. `@ever-works/minio-plugin`.
 *   - `github-storage`     — GitHub repo blobs. `@ever-works/github-storage-plugin`.
 *
 * The non-default backends are loaded via dynamic `import()` so deployments
 * that only use local-fs don't have to install the heavy AWS SDK or octokit.
 * If the import fails (missing package, bad env), we throw at boot — better
 * loud than silently falling back to local disk.
 *
 * The factory keeps a single instance per backend across the process. It
 * also runs the plugin's `onLoad` lifecycle hook with a minimal stub
 * context so logging works the same as in the standard plugin loader
 * path. Settings access (`getSettings`, cache, http, events) is not used
 * by storage plugins — they resolve config directly from env vars — so
 * the stub keeps those as no-ops.
 */
function makeStubContext(pluginId: string): PluginContext {
    const nestLogger = new Logger(`StoragePlugin/${pluginId}`);
    const logger: PluginLogger = {
        log: (m, ...a) => nestLogger.log(formatMsg(m, a)),
        error: (m, ...a) => nestLogger.error(formatMsg(m, a)),
        warn: (m, ...a) => nestLogger.warn(formatMsg(m, a)),
        debug: (m, ...a) => nestLogger.debug(formatMsg(m, a)),
        verbose: (m, ...a) => nestLogger.verbose?.(formatMsg(m, a)),
    };
    // Storage plugins only ever touch `logger` and `pluginId` in our
    // codebase. Anything else is cast through `unknown` so we don't have
    // to stub the entire plugin SDK surface (cache, http, events, etc).
    return {
        pluginId,
        logger,
    } as unknown as PluginContext;
}

function formatMsg(message: string, args: unknown[]): string {
    if (args.length === 0) return message;
    return `${message} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
}

export type StorageBackendId = 'local-fs' | 'aws-s3' | 'minio' | 'github-storage';

let cached: IStoragePlugin | undefined;
let cachedId: StorageBackendId | undefined;

export function resolveStorageBackendId(): StorageBackendId {
    const raw = (process.env.STORAGE_BACKEND || 'local-fs').toLowerCase();
    switch (raw) {
        case 'local-fs':
        case 'aws-s3':
        case 'minio':
        case 'github-storage':
            return raw;
        default:
            throw new Error(
                `STORAGE_BACKEND="${raw}" is not a supported backend. ` +
                    `Choose one of: local-fs, aws-s3, minio, github-storage.`,
            );
    }
}

export async function getActiveStorageBackend(): Promise<IStoragePlugin> {
    const wanted = resolveStorageBackendId();
    if (cached && cachedId === wanted) return cached;

    const plugin = await instantiate(wanted);
    await plugin.onLoad(makeStubContext(plugin.id));

    cached = plugin;
    cachedId = wanted;
    return plugin;
}

/**
 * Reset the cached backend. Tests use this when they want to swap
 * STORAGE_BACKEND between cases; production code never calls it.
 */
export function resetStorageBackendCache(): void {
    cached = undefined;
    cachedId = undefined;
}

async function instantiate(id: StorageBackendId): Promise<IStoragePlugin> {
    switch (id) {
        case 'local-fs':
            // Bundled — always available, no dynamic import needed.
            return new LocalFsStoragePlugin();
        case 'aws-s3': {
            const mod = await import('@ever-works/aws-s3-plugin').catch((err) => {
                throw new Error(
                    `STORAGE_BACKEND=aws-s3 but @ever-works/aws-s3-plugin failed to load: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            });
            return new mod.AwsS3StoragePlugin();
        }
        case 'minio': {
            const mod = await import('@ever-works/minio-plugin').catch((err) => {
                throw new Error(
                    `STORAGE_BACKEND=minio but @ever-works/minio-plugin failed to load: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            });
            return new mod.MinioStoragePlugin();
        }
        case 'github-storage': {
            const mod = await import('@ever-works/github-storage-plugin').catch((err) => {
                throw new Error(
                    `STORAGE_BACKEND=github-storage but @ever-works/github-storage-plugin failed to load: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            });
            return new mod.GitHubStoragePlugin();
        }
    }
}
