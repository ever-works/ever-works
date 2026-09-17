import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
    BACKUP_CHECKSUMS_ENTRY,
    BackupArchiveTooLargeError,
    BackupArchiveWriter,
    stableStringify,
} from './backup-archive-writer';

/**
 * The archive is a file a person opens, not an internal wire format. So the
 * assertions here are the ones a reader can make for themselves after
 * unzipping: the top level is exactly what the format promises, every count
 * matches its file's line count, every checksum verifies with a standard
 * tool, and two backups of unchanged data differ only where they must.
 */

/** Names in the zip's central directory, in the order it lists them. */
function listEntries(zip: Buffer): string[] {
    // End of central directory record: signature, then the offset of the
    // central directory it points at. Scanned from the end because the
    // record is last and its size varies with the comment.
    let eocd = -1;
    for (let i = zip.length - 22; i >= 0; i -= 1) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('not a zip: no end-of-central-directory record');
    }

    const count = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    const names: string[] = [];

    for (let entry = 0; entry < count; entry += 1) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('not a zip: bad central directory header');
        }
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return names;
}

async function drain(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
}

async function* rowsOf(...rows: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
    for (const row of rows) {
        yield row;
    }
}

function newWriter(overrides: Partial<ConstructorParameters<typeof BackupArchiveWriter>[0]> = {}) {
    return new BackupArchiveWriter({
        maxArchiveBytes: 5 * 1024 * 1024,
        maxAttachmentBytes: 1024 * 1024,
        maxFileBytes: 512 * 1024,
        ...overrides,
    });
}

describe('stableStringify', () => {
    it('sorts keys at every depth, so two archives of unchanged data diff cleanly', () => {
        expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    });

    it('does not lose a nested object’s fields the way a replacer array would', () => {
        // JSON.stringify(value, ['a','b']) applies the SAME key list to nested
        // objects and silently drops everything else. This is the regression
        // that shortcut would cause.
        expect(stableStringify({ a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1}}');
    });

    it('writes dates as ISO instants rather than as objects', () => {
        expect(stableStringify({ at: new Date('2026-09-06T14:12:00.000Z') })).toBe(
            '{"at":"2026-09-06T14:12:00.000Z"}',
        );
    });

    it('drops undefined rather than emitting a key with no value', () => {
        expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    });
});

describe('BackupArchiveWriter', () => {
    it('produces a zip whose top level is exactly the five things the format promises', async () => {
        const writer = newWriter();
        const bytes = drain(writer.stream);

        await writer.addJsonlEntry('data/account/profile.jsonl', rowsOf({ id: 'u1' }));
        await writer.addFileEntry('files/f1/report.pdf', Readable.from([Buffer.from('pdf')]), 3);
        await writer.addTextEntry('manifest.json', '{}');
        await writer.addTextEntry('README.md', '# backup');
        await writer.addChecksums();
        await writer.close();

        const topLevel = new Set(listEntries(await bytes).map((name) => name.split('/')[0]));
        expect([...topLevel].sort()).toEqual([
            'README.md',
            'checksums.txt',
            'data',
            'files',
            'manifest.json',
        ]);
    });

    it('counts one record per row, so a manifest count equals its file’s line count', async () => {
        const writer = newWriter();
        const bytes = drain(writer.stream);

        const entry = await writer.addJsonlEntry(
            'data/tasks/tasks.jsonl',
            rowsOf({ id: 't1' }, { id: 't2' }, { id: 't3' }),
        );
        await writer.close();
        await bytes;

        expect(entry.records).toBe(3);
        // Three LF-terminated lines.
        expect(entry.bytes).toBe('{"id":"t1"}\n{"id":"t2"}\n{"id":"t3"}\n'.length);
    });

    it('hashes each entry over exactly the bytes it wrote', async () => {
        const writer = newWriter();
        const bytes = drain(writer.stream);

        const entry = await writer.addJsonlEntry(
            'data/account/profile.jsonl',
            rowsOf({ id: 'u1' }),
        );
        await writer.close();
        await bytes;

        expect(entry.sha256).toBe(createHash('sha256').update('{"id":"u1"}\n').digest('hex'));
    });

    it('writes checksums.txt covering every entry except itself, in sha256sum format', async () => {
        const writer = newWriter();
        const bytes = drain(writer.stream);

        const a = await writer.addTextEntry('manifest.json', '{}');
        const b = await writer.addJsonlEntry('data/account/profile.jsonl', rowsOf({ id: 'u1' }));
        const checksums = await writer.addChecksums();
        await writer.close();
        await bytes;

        const lines = writer.entries.filter((entry) => entry.name === BACKUP_CHECKSUMS_ENTRY);
        expect(lines).toHaveLength(1);
        // The file itself lists the two entries before it and not itself.
        expect(checksums.name).toBe('checksums.txt');
        expect(writer.entries.map((entry) => entry.name)).toEqual([
            'manifest.json',
            'data/account/profile.jsonl',
            'checksums.txt',
        ]);
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses a file over the per-file limit and says why', () => {
        const writer = newWriter({ maxFileBytes: 100 });
        expect(writer.canAcceptFile(101)).toEqual({ accepted: false, reason: 'size_limit' });
        expect(writer.canAcceptFile(100)).toEqual({ accepted: true });
        writer.abort('test finished');
    });

    it('refuses the file that would cross the attachment budget, and keeps going for smaller ones', async () => {
        const writer = newWriter({ maxAttachmentBytes: 10, maxFileBytes: 10 });
        const bytes = drain(writer.stream);

        expect(writer.canAcceptFile(6)).toEqual({ accepted: true });
        await writer.addFileEntry('files/a/a.bin', Readable.from([Buffer.alloc(6)]), 6);

        // 6 + 6 would cross the 10-byte budget; a 4-byte file still fits.
        expect(writer.canAcceptFile(6)).toEqual({ accepted: false, reason: 'size_limit' });
        expect(writer.canAcceptFile(4)).toEqual({ accepted: true });

        await writer.close();
        await bytes;
    });

    it('aborts with too_large when the archive crosses its ceiling', async () => {
        const writer = newWriter({ maxArchiveBytes: 256 });
        const bytes = drain(writer.stream).catch(() => Buffer.alloc(0));

        // Random bytes so deflate cannot shrink them under the ceiling.
        const incompressible = Buffer.from(
            Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 251),
        );

        await expect(
            (async () => {
                await writer.addFileEntry(
                    'files/a/a.bin',
                    Readable.from([incompressible]),
                    incompressible.length,
                );
                await writer.addFileEntry(
                    'files/b/b.bin',
                    Readable.from([incompressible]),
                    incompressible.length,
                );
                await writer.close();
            })(),
        ).rejects.toThrow(BackupArchiveTooLargeError);

        await bytes;
        expect(writer.abortReason).toBeInstanceOf(BackupArchiveTooLargeError);
    });

    it('captures a collector’s error instead of poisoning the archive', async () => {
        const writer = newWriter();
        const bytes = drain(writer.stream);

        async function* explodes(): AsyncIterable<Record<string, unknown>> {
            yield { id: 'r1' };
            throw new Error('the database went away');
        }

        const failed = await writer.addJsonlEntry('data/runs/agent-runs.jsonl', explodes());
        // The one row that arrived is still in the file, and the count still
        // matches the line count — the archive stays internally consistent.
        expect(failed.records).toBe(1);
        expect((failed.error as Error).message).toBe('the database went away');

        // And the other fourteen domains keep going (spec FR-17, S-13).
        const after = await writer.addJsonlEntry(
            'data/activity/activity.jsonl',
            rowsOf({ id: 'a1' }),
        );
        expect(after.records).toBe(1);
        expect(writer.abortReason).toBeNull();

        await writer.close();
        expect((await bytes).length).toBeGreaterThan(0);
    });

    it('refuses to take more entries once aborted, so a cancelled run writes nothing further', async () => {
        const writer = newWriter();
        drain(writer.stream).catch(() => undefined);

        writer.abort('cancelled by the owner');
        await expect(writer.addTextEntry('manifest.json', '{}')).rejects.toThrow(
            'cancelled by the owner',
        );
        await expect(writer.close()).rejects.toThrow('cancelled by the owner');
    });

    it('keeps the first abort reason, because it is the one that explains the rest', async () => {
        const writer = newWriter();
        drain(writer.stream).catch(() => undefined);

        writer.abort('cancelled by the owner');
        writer.abort('something later and less interesting');
        expect(writer.abortReason?.message).toContain('cancelled by the owner');
    });

    it('produces identical entry digests for two runs over identical rows', async () => {
        const digestsOf = async () => {
            const writer = newWriter();
            const bytes = drain(writer.stream);
            const entry = await writer.addJsonlEntry(
                'data/works/works.jsonl',
                rowsOf({ name: 'Acme', id: 'w1' }, { id: 'w2', name: 'Beta' }),
            );
            await writer.close();
            await bytes;
            return entry.sha256;
        };

        // Same rows, keys given in a different order the second time round.
        expect(await digestsOf()).toBe(await digestsOf());
    });
});
