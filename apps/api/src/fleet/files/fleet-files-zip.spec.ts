import { crc32Update, FleetZipWriter } from './fleet-files-zip';

/**
 * Files on computers (FL-11, T-09) — the streaming zip writer: store-only
 * entries with data descriptors, UTF-8 names, folders, links, and a central
 * directory a zip reader can walk. Written, not run (fast-build rule).
 */

function build(
    entries: Array<{
        path: string;
        kind: 'file' | 'folder' | 'link';
        text?: string;
        target?: string;
    }>,
) {
    const chunks: Buffer[] = [];
    const zip = new FleetZipWriter((chunk) => chunks.push(Buffer.from(chunk)));
    for (const entry of entries) {
        const bytes = Buffer.from(entry.text ?? '', 'utf8');
        zip.entry({
            path: entry.path,
            kind: entry.kind,
            size: entry.kind === 'file' ? bytes.length : 0,
            mode: 0o644,
            mtimeMs: Date.UTC(2026, 9, 21, 9, 40),
            ...(entry.target ? { target: entry.target } : {}),
        });
        if (entry.kind === 'file' && bytes.length > 0) zip.data(bytes);
    }
    zip.finish();
    return { archive: Buffer.concat(chunks), written: zip.bytesWritten };
}

/** Walk the central directory: name, CRC, size, local offset. */
function readCentral(archive: Buffer) {
    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    const count = archive.readUInt16LE(end + 10);
    let at = archive.readUInt32LE(end + 16);
    const out: Array<{
        name: string;
        crc: number;
        size: number;
        offset: number;
        attributes: number;
    }> = [];
    for (let i = 0; i < count; i += 1) {
        expect(archive.readUInt32LE(at)).toBe(0x02014b50);
        const nameLength = archive.readUInt16LE(at + 28);
        out.push({
            crc: archive.readUInt32LE(at + 16),
            size: archive.readUInt32LE(at + 24),
            attributes: archive.readUInt32LE(at + 38),
            offset: archive.readUInt32LE(at + 42),
            name: archive.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
        });
        at += 46 + nameLength;
    }
    return out;
}

describe('FleetZipWriter', () => {
    it('computes the standard CRC-32', () => {
        expect(crc32Update(0, Buffer.from('123456789'))).toBe(0xcbf43926);
        // Incremental equals one-shot.
        expect(crc32Update(crc32Update(0, Buffer.from('1234')), Buffer.from('56789'))).toBe(
            0xcbf43926,
        );
    });

    it('writes files, folders and links with a readable central directory', () => {
        const { archive, written } = build([
            { path: 'routes', kind: 'folder' },
            { path: 'routes/app.ts', kind: 'file', text: 'export {};\n' },
            { path: 'routes/é.txt', kind: 'file', text: 'utf-8 name' },
            { path: 'routes/current', kind: 'link', target: 'app.ts' },
        ]);
        expect(written).toBe(archive.length);
        const central = readCentral(archive);
        expect(central.map((entry) => entry.name)).toEqual([
            'routes/',
            'routes/app.ts',
            'routes/é.txt',
            'routes/current',
        ]);
        const app = central[1];
        expect(app.size).toBe(11);
        expect(app.crc).toBe(crc32Update(0, Buffer.from('export {};\n')));
        expect(archive.readUInt32LE(app.offset)).toBe(0x04034b50);
        // The folder carries the directory bit; the link a unix symlink mode.
        expect(central[0].attributes & 0x10).toBe(0x10);
        expect((central[3].attributes >>> 16) & 0o170000).toBe(0o120000);
        expect(central[3].size).toBe(Buffer.byteLength('app.ts'));
    });

    it('marks names UTF-8 and uses data descriptors', () => {
        const { archive } = build([{ path: 'a.txt', kind: 'file', text: 'x' }]);
        expect(archive.readUInt16LE(6) & 0x0808).toBe(0x0808);
        expect(archive.readUInt16LE(8)).toBe(0); // stored
    });
});
