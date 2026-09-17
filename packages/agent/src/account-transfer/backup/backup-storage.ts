import type { Readable } from 'node:stream';
import type { IStoragePlugin } from '@ever-works/plugin';

/**
 * Workspace backup (AW-22) — where the archive's bytes live.
 *
 * The runner never touches a filesystem, never imports a cloud SDK and never
 * names a backend. It writes through whatever `IStoragePlugin` the
 * deployment has selected, resolved for it by the API and handed over at this
 * DI token (Constitution I and II).
 *
 * ## Capability probe, not a backend check
 *
 * Streaming is an OPTIONAL pair of methods on the storage contract. This
 * accessor asks the plugin whether it has them — `typeof
 * plugin.putObjectStream === 'function'` — and never asks which backend it
 * is. A backend without streaming still produces a correct archive; it just
 * carries a smaller ceiling, because the bytes have to pass through one
 * buffer. A smaller limit is a fine answer. A wrong result is not.
 */

/** DI token the API binds to the active storage backend. */
export const BACKUP_STORAGE = Symbol('BACKUP_STORAGE');

/** Where an archive ended up. */
export interface StoredArchive {
    readonly key: string;
    readonly backend: string;
}

/** An archive being read back, streamed. */
export interface ArchiveDownload {
    readonly stream: Readable;
    readonly mimeType: string;
    readonly size?: number;
}

export interface PutArchiveMeta {
    readonly filename: string;
    /** The owner the archive is filed under, so backends that scope by owner can. */
    readonly ownerId: string;
    /** Bytes, where the caller knows them up front. */
    readonly expectedSize?: number;
}

/**
 * The seam the runner, the service and the sweeper depend on. Deliberately
 * narrow: four verbs and one question, none of which mention a backend.
 */
export interface BackupStorage {
    /**
     * Resolve the backend before anything else asks a question about it, so
     * the synchronous probes below have an answer. Optional: a test double
     * that is already "resolved" does not need one.
     */
    warmUp?(): Promise<void>;
    /** Can the active backend take a stream? Decides which archive ceiling applies. */
    supportsStreaming(): boolean;
    /** Which backend holds it, recorded on the row so support can find it. */
    backendName(): string;
    /** Write the archive. Streams when the backend can, buffers only when it cannot. */
    putArchive(source: Readable, meta: PutArchiveMeta): Promise<StoredArchive>;
    /** Read it back without buffering it. */
    getArchiveStream(key: string): Promise<ArchiveDownload>;
    /**
     * Read any other stored object — an uploaded document's bytes on their
     * way into `files/` — through the same backend, with the mime type the
     * backend reports rather than the archive's.
     */
    readObject(key: string): Promise<ArchiveDownload>;
    /** Remove the bytes. Idempotent — a key that is already gone is a success. */
    deleteArchive(key: string): Promise<void>;
}

/** The media type an archive is written and served as. */
export const BACKUP_ARCHIVE_MIME_TYPE = 'application/zip';

/**
 * The accessor over one storage plugin.
 *
 * Constructed by the API with a resolver rather than a plugin instance,
 * because the active backend is selected and lazily loaded at boot and the
 * agent package must not import the API's module graph to find it — the same
 * token-plus-resolver indirection `uploads.service.ts` uses to keep TypeORM
 * out of its own unit-test import graph.
 */
export class PluginBackupStorage implements BackupStorage {
    private plugin: IStoragePlugin | null = null;

    constructor(private readonly resolve: () => Promise<IStoragePlugin>) {}

    /**
     * Resolve once and keep it. A deployment does not change its storage
     * backend while the process is up, and the resolver behind this is
     * already cached on the API side.
     */
    private async backend(): Promise<IStoragePlugin> {
        if (!this.plugin) {
            this.plugin = await this.resolve();
        }
        return this.plugin;
    }

    /**
     * Prime the cached plugin so the synchronous probes below can answer.
     * Called once by the runner before it opens the archive, and by the
     * service when it decides whether backups are available at all.
     */
    async warmUp(): Promise<void> {
        await this.backend();
    }

    supportsStreaming(): boolean {
        const plugin = this.plugin;
        if (!plugin) {
            // Not resolved yet — assume the smaller ceiling rather than
            // promising a capability we have not observed.
            return false;
        }
        return (
            typeof plugin.putObjectStream === 'function' &&
            typeof plugin.getObjectStream === 'function'
        );
    }

    backendName(): string {
        return this.plugin?.providerName ?? 'unknown';
    }

    async putArchive(source: Readable, meta: PutArchiveMeta): Promise<StoredArchive> {
        const plugin = await this.backend();

        if (typeof plugin.putObjectStream === 'function') {
            const result = await plugin.putObjectStream({
                stream: source,
                filename: meta.filename,
                mimeType: BACKUP_ARCHIVE_MIME_TYPE,
                ownerId: meta.ownerId,
                ...(meta.expectedSize === undefined ? {} : { expectedSize: meta.expectedSize }),
            });
            return { key: result.key, backend: plugin.providerName };
        }

        // No streaming on this backend. The bytes have to be collected, which
        // is exactly why the runner applied the smaller ceiling before it
        // started writing — see `supportsStreaming`.
        const chunks: Buffer[] = [];
        for await (const chunk of source) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        const buffer = Buffer.concat(chunks);
        const result = await plugin.putObject({
            buffer,
            filename: meta.filename,
            mimeType: BACKUP_ARCHIVE_MIME_TYPE,
            size: buffer.length,
            ownerId: meta.ownerId,
        });
        return { key: result.key, backend: plugin.providerName };
    }

    async getArchiveStream(key: string): Promise<ArchiveDownload> {
        const result = await this.readObject(key);
        // The archive's type is ours to state, whatever the backend recovered
        // from the key's extension.
        return { ...result, mimeType: BACKUP_ARCHIVE_MIME_TYPE };
    }

    async readObject(key: string): Promise<ArchiveDownload> {
        const plugin = await this.backend();

        if (typeof plugin.getObjectStream === 'function') {
            const result = await plugin.getObjectStream(key);
            return {
                stream: result.stream,
                mimeType: result.mimeType,
                ...(result.size === undefined ? {} : { size: result.size }),
            };
        }

        const { buffer, mimeType } = await plugin.getObject(key);
        const { Readable: NodeReadable } = await import('node:stream');
        return { stream: NodeReadable.from(buffer), mimeType, size: buffer.length };
    }

    async deleteArchive(key: string): Promise<void> {
        const plugin = await this.backend();
        await plugin.deleteObject(key);
    }
}
