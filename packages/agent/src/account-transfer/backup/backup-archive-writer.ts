import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import archiver from 'archiver';

/**
 * Workspace backup (AW-22) — the zip container, written as a stream.
 *
 * The whole point of this epic is that an archive's size stops mattering.
 * That is only true if the bytes never sit in one buffer: the writer opens a
 * zip STREAM, each entry is appended from its own source stream, and the
 * result is piped straight at the storage backend. Nothing here ever holds
 * the archive, a domain, or a page of rows in memory at once.
 *
 * `jszip` is already a dependency of this package and is deliberately NOT
 * used: it builds the whole archive in memory, which is precisely the
 * property being removed. It keeps doing its job for the small plugin
 * bundles in `../../agent-plugins/export.service.ts`.
 *
 * The writer owns four things the manifest and the limits depend on:
 *
 *  - **A SHA-256 per entry**, and one over the finished archive, so
 *    `checksums.txt` can be verified with a standard command-line tool and
 *    the download response can carry the archive's digest.
 *  - **A record count per JSONL entry**, so every count in `manifest.json`
 *    equals the number of lines in the file it describes.
 *  - **Running byte counters** for the attachment budget and the archive
 *    ceiling, checked as bytes are produced rather than guessed beforehand.
 *  - **A clean abort**, so a cancelled backup destroys the stream and leaves
 *    no half-written object behind.
 */

/** What one entry contributed, as the manifest records it. */
export interface BackupArchiveEntry {
    /** Archive-relative path, e.g. `data/runs/run-logs.jsonl`. */
    readonly name: string;
    /** Lines, for a JSONL entry. `0` for text and file entries. */
    readonly records: number;
    readonly sha256: string;
    /** Uncompressed bytes this entry contributed. */
    readonly bytes: number;
    /**
     * The error that stopped this entry's rows part way through, if one did.
     *
     * A collector that throws must NOT poison the archive: spec FR-17 says
     * the other fourteen domains still finish. So the row iteration's error
     * is captured here and the zip entry is closed cleanly with whatever
     * rows arrived — the manifest then marks that domain `failed` with the
     * error code, and its record count still equals the file's line count.
     */
    readonly error?: unknown;
}

export interface BackupArchiveWriterOptions {
    /** Hard ceiling on the finished archive. Crossing it aborts with `too_large`. */
    readonly maxArchiveBytes: number;
    /** Ceiling on uploaded file bytes across the whole archive (spec FR-15). */
    readonly maxAttachmentBytes: number;
    /** Ceiling on any single uploaded file (spec FR-15). */
    readonly maxFileBytes: number;
    /**
     * Deflate level. The default trades a little CPU for a much smaller
     * archive, because a workspace's structured data is almost all text.
     */
    readonly compressionLevel?: number;
}

/** Why the writer refused to carry a file's bytes. */
export type BackupFileRefusal = 'size_limit';

/** Raised when the finished archive would cross its ceiling (spec FR-16). */
export class BackupArchiveTooLargeError extends Error {
    constructor(
        readonly bytes: number,
        readonly limit: number,
    ) {
        super(`Archive exceeded its ${limit}-byte ceiling at ${bytes} bytes`);
        this.name = 'BackupArchiveTooLargeError';
    }
}

/** Raised when an entry is added after the writer was aborted. */
export class BackupArchiveAbortedError extends Error {
    constructor(reason?: string) {
        super(reason ? `Archive aborted: ${reason}` : 'Archive aborted');
        this.name = 'BackupArchiveAbortedError';
    }
}

/**
 * Deterministic JSON: object keys in sorted order at every depth, so two
 * archives of unchanged data differ only in their timestamps and identifiers
 * (spec FR-22). `JSON.stringify`'s replacer-array trick cannot be used — it
 * applies the same key list to nested objects and silently drops their
 * fields.
 */
export function stableStringify(value: unknown): string {
    return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('base64');
    }
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
        const entry = source[key];
        if (entry === undefined) continue;
        out[key] = normalize(entry);
    }
    return out;
}

/** The checksum file every archive ends with, in `sha256sum` format. */
export const BACKUP_CHECKSUMS_ENTRY = 'checksums.txt';

export class BackupArchiveWriter {
    private readonly archive: archiver.Archiver;
    private readonly archiveHash = createHash('sha256');
    private readonly out = new PassThrough();
    private readonly written: BackupArchiveEntry[] = [];
    private readonly finished: Promise<void>;

    private archiveBytes = 0;
    private attachmentBytesUsed = 0;
    private aborted: Error | null = null;
    private closed = false;
    /** Serialises appends so entries land in a deterministic order. */
    private queue: Promise<unknown> = Promise.resolve();
    /**
     * Appends still waiting on archiver. An abort settles all of them: the
     * zip stream is gone, so the entry event they are waiting for will never
     * arrive and a caller would otherwise hang until the job's ceiling.
     */
    private readonly pending = new Set<(error: Error) => void>();

    constructor(private readonly options: BackupArchiveWriterOptions) {
        this.archive = archiver('zip', {
            zlib: { level: options.compressionLevel ?? 6 },
        });

        this.archive.on('warning', (error) => {
            // ENOENT from archiver is a missing source, which a collector
            // already reports as an omission. Anything else is real.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.abort(error);
            }
        });
        this.archive.on('error', (error) => this.abort(error));

        this.archive.on('data', (chunk: Buffer) => {
            this.archiveBytes += chunk.length;
            this.archiveHash.update(chunk);
            if (this.archiveBytes > this.options.maxArchiveBytes && !this.aborted) {
                this.abort(
                    new BackupArchiveTooLargeError(this.archiveBytes, this.options.maxArchiveBytes),
                );
            }
        });

        this.archive.pipe(this.out);
        this.finished = new Promise<void>((resolve, reject) => {
            this.out.on('end', resolve);
            this.out.on('close', resolve);
            this.out.on('error', reject);
        });
        // An abort rejects this promise, and an abort can happen when nobody
        // is waiting on `close()` — a cancelled backup, for instance. Claim
        // the rejection here so it never surfaces as an unhandled one and
        // takes the worker process down; `close()` still sees it.
        this.finished.catch(() => undefined);
    }

    /** The zip bytes. Pipe this straight at the storage backend; never buffer it. */
    get stream(): Readable {
        return this.out;
    }

    /** Compressed bytes produced so far. */
    get bytesWritten(): number {
        return this.archiveBytes;
    }

    /** Uploaded-file bytes carried so far, against the attachment budget. */
    get attachmentBytes(): number {
        return this.attachmentBytesUsed;
    }

    /** Every entry written so far, in the order it was written. */
    get entries(): readonly BackupArchiveEntry[] {
        return this.written;
    }

    /**
     * Would this file's bytes fit? Asked BEFORE a stream is opened, so a file
     * that cannot travel is recorded as an omission without reading it
     * (spec FR-15, S-11).
     */
    canAcceptFile(sizeBytes: number): { accepted: boolean; reason?: BackupFileRefusal } {
        if (sizeBytes > this.options.maxFileBytes) {
            return { accepted: false, reason: 'size_limit' };
        }
        if (this.attachmentBytesUsed + sizeBytes > this.options.maxAttachmentBytes) {
            return { accepted: false, reason: 'size_limit' };
        }
        return { accepted: true };
    }

    /** A small text entry — `manifest.json`, `README.md`. */
    addTextEntry(name: string, text: string): Promise<BackupArchiveEntry> {
        const buffer = Buffer.from(text, 'utf8');
        return this.enqueue(name, () => {
            const sha256 = createHash('sha256').update(buffer).digest('hex');
            this.archive.append(buffer, { name });
            return Promise.resolve({ name, records: 0, sha256, bytes: buffer.length });
        });
    }

    /**
     * One newline-delimited JSON file. Each row becomes one LF-terminated
     * line with its keys in a stable order; rows are consumed lazily, so a
     * collector paging a million rows costs one page of memory.
     */
    addJsonlEntry(
        name: string,
        rows: AsyncIterable<Record<string, unknown>>,
    ): Promise<BackupArchiveEntry> {
        return this.enqueue(name, async () => {
            const hash = createHash('sha256');
            let records = 0;
            let bytes = 0;
            let failure: unknown;

            const source = Readable.from(
                (async function* serialise() {
                    try {
                        for await (const row of rows) {
                            const line = `${stableStringify(row)}\n`;
                            const chunk = Buffer.from(line, 'utf8');
                            hash.update(chunk);
                            records += 1;
                            bytes += chunk.length;
                            yield chunk;
                        }
                    } catch (error) {
                        // End the entry cleanly and report out of band, so
                        // one domain's failure costs only that domain.
                        failure = error;
                    }
                })(),
            );

            await this.appendAndDrain(source, name);
            return {
                name,
                records,
                sha256: hash.digest('hex'),
                bytes,
                ...(failure === undefined ? {} : { error: failure }),
            };
        });
    }

    /**
     * An uploaded file's actual bytes. The caller has already asked
     * {@link canAcceptFile}; this charges the attachment budget as the bytes
     * go past, so a source that lied about its size still cannot overrun it.
     */
    addFileEntry(name: string, source: Readable, sizeBytes: number): Promise<BackupArchiveEntry> {
        return this.enqueue(name, async () => {
            const hash = createHash('sha256');
            let bytes = 0;

            const metered = new PassThrough();
            source.on('error', (error) => metered.destroy(error));
            source.on('data', (chunk: Buffer) => {
                hash.update(chunk);
                bytes += chunk.length;
            });
            source.pipe(metered);

            await this.appendAndDrain(metered, name);
            this.attachmentBytesUsed += bytes || sizeBytes;
            return { name, records: 0, sha256: hash.digest('hex'), bytes };
        });
    }

    /**
     * `checksums.txt`, covering every entry except itself, in the format
     * `sha256sum -c` reads (spec FR-25). Written last, so it can describe
     * everything before it.
     */
    async addChecksums(): Promise<BackupArchiveEntry> {
        const body = this.written.map((entry) => `${entry.sha256}  ${entry.name}`).join('\n');
        return this.addTextEntry(BACKUP_CHECKSUMS_ENTRY, body.length > 0 ? `${body}\n` : '');
    }

    /**
     * Finish the zip and resolve once the last byte has left the stream.
     * Returns the archive's own digest and size, which go onto the record.
     */
    async close(): Promise<{ sha256: string; bytes: number }> {
        if (this.aborted) {
            throw this.aborted;
        }
        await this.queue;
        this.closed = true;
        await this.archive.finalize();
        await this.finished;
        if (this.aborted) {
            throw this.aborted;
        }
        return { sha256: this.archiveHash.digest('hex'), bytes: this.archiveBytes };
    }

    /**
     * Stop immediately and destroy the stream, so a cancelled backup leaves
     * no partial object on storage (spec FR-8). Idempotent: the first reason
     * wins, because it is the one that explains the rest.
     */
    abort(error?: Error | string): void {
        if (this.aborted) {
            return;
        }
        this.aborted = error instanceof Error ? error : new BackupArchiveAbortedError(error);
        this.archive.abort();
        this.out.destroy(this.aborted);
        for (const reject of [...this.pending]) {
            reject(this.aborted);
        }
        this.pending.clear();
    }

    /** Has this writer been aborted, and why? */
    get abortReason(): Error | null {
        return this.aborted;
    }

    private enqueue<T extends BackupArchiveEntry>(
        name: string,
        work: () => Promise<T> | T,
    ): Promise<T> {
        const next = this.queue.then(async () => {
            if (this.aborted) {
                throw this.aborted;
            }
            if (this.closed) {
                throw new BackupArchiveAbortedError('writer already closed');
            }
            const entry = await work();
            this.written.push(entry);
            if (this.aborted) {
                throw this.aborted;
            }
            return entry;
        });
        // Keep the chain alive even when one entry rejects, so a later abort
        // does not surface as an unhandled rejection.
        this.queue = next.catch(() => undefined);
        void this.queue;
        return next;
    }

    /**
     * Append one source and wait for archiver to finish reading it. Waiting
     * per entry is what gives the writer backpressure: without it, every
     * collector would race to append and archiver would buffer them all.
     */
    private appendAndDrain(source: Readable, name: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const onEntry = (entry: archiver.EntryData) => {
                if (entry.name === name) {
                    cleanup();
                    resolve();
                }
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const cleanup = () => {
                this.pending.delete(onError);
                this.archive.off('entry', onEntry);
                this.archive.off('error', onError);
                source.off('error', onError);
            };

            if (this.aborted) {
                reject(this.aborted);
                return;
            }

            this.pending.add(onError);
            this.archive.on('entry', onEntry);
            this.archive.on('error', onError);
            source.on('error', onError);
            this.archive.append(source, { name });
        });
    }
}
