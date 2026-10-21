import type { FleetFilesStreamHeader } from '@ever-works/contracts';

/**
 * Files on computers (FL-11, plan §3 "Browser download shape") — a streaming
 * zip writer for a download of several entries or a folder.
 *
 * The node sends a files stream (headers and bytes, never zip — the machine
 * stays simple); this turns it into a plain zip on the fly, `store` only
 * (no compression — spec §8 out of scope; the platform's CPU stays low), so
 * nothing is buffered beyond the entry header being written. Sizes are known
 * from the stream, the CRC is not until the bytes went by, so every entry
 * carries a data descriptor (general-purpose flag bit 3) and names are UTF-8
 * (bit 11). A transfer is capped at 2 GiB, so the classic (non-zip64) format
 * always fits. Links are stored as links (unix mode `0120777`, the target as
 * the entry's content), as `zip -y` writes them.
 *
 * Written by hand rather than with an archive library: the API package has
 * none it may import without a lockfile change (lane log decision 1).
 */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32Update(crc: number, bytes: Uint8Array): number {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;
/** Made by: unix (3), spec 2.0 — so the external attributes carry unix modes. */
const VERSION_MADE_BY = (3 << 8) | 20;

function dosDateTime(mtimeMs: number): { time: number; date: number } {
    const when = new Date(mtimeMs > 0 ? mtimeMs : Date.now());
    const year = Math.min(Math.max(when.getFullYear(), 1980), 2107);
    return {
        time:
            (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    };
}

interface CentralEntry {
    name: Buffer;
    crc: number;
    size: number;
    offset: number;
    time: number;
    date: number;
    attributes: number;
}

export class FleetZipWriter {
    private offset = 0;
    private readonly central: CentralEntry[] = [];
    private current: (CentralEntry & { open: true }) | null = null;
    private finished = false;

    /** `write` receives every byte of the archive, in order. */
    constructor(private readonly write: (chunk: Buffer) => void) {}

    get bytesWritten(): number {
        return this.offset;
    }

    /** One stream entry: opens it (and, for a folder or a link, closes it at once). */
    entry(header: FleetFilesStreamHeader): void {
        this.closeEntry();
        const isFolder = header.kind === 'folder';
        const name = Buffer.from(isFolder ? `${header.path}/` : header.path, 'utf8');
        const { time, date } = dosDateTime(header.mtimeMs);
        const unixMode =
            header.kind === 'folder'
                ? 0o040000 | (header.mode || 0o755)
                : header.kind === 'link'
                  ? 0o120777
                  : 0o100000 | (header.mode || 0o644);
        const attributes = ((unixMode & 0xffff) << 16) | (isFolder ? 0x10 : 0);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(VERSION_NEEDED, 4);
        local.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
        local.writeUInt16LE(0, 8); // store
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        // CRC and sizes follow in the data descriptor (bit 3): zero here.
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        this.current = {
            open: true,
            name,
            crc: 0,
            size: 0,
            offset: this.offset,
            time,
            date,
            attributes: attributes >>> 0,
        };
        this.emit(local);
        this.emit(name);
        if (header.kind === 'link' && header.target) this.data(Buffer.from(header.target, 'utf8'));
        if (header.kind !== 'file') this.closeEntry();
    }

    /** Bytes of the open file entry. */
    data(bytes: Uint8Array): void {
        if (!this.current || bytes.byteLength === 0) return;
        this.current.crc = crc32Update(this.current.crc, bytes);
        this.current.size += bytes.byteLength;
        this.emit(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }

    /** The central directory and its end record. */
    finish(): void {
        if (this.finished) return;
        this.closeEntry();
        this.finished = true;
        const start = this.offset;
        for (const entry of this.central) {
            const header = Buffer.alloc(46);
            header.writeUInt32LE(0x02014b50, 0);
            header.writeUInt16LE(VERSION_MADE_BY, 4);
            header.writeUInt16LE(VERSION_NEEDED, 6);
            header.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
            header.writeUInt16LE(0, 10);
            header.writeUInt16LE(entry.time, 12);
            header.writeUInt16LE(entry.date, 14);
            header.writeUInt32LE(entry.crc, 16);
            header.writeUInt32LE(entry.size, 20);
            header.writeUInt32LE(entry.size, 24);
            header.writeUInt16LE(entry.name.length, 28);
            header.writeUInt16LE(0, 30); // extra
            header.writeUInt16LE(0, 32); // comment
            header.writeUInt16LE(0, 34); // disk
            header.writeUInt16LE(0, 36); // internal attributes
            header.writeUInt32LE(entry.attributes, 38);
            header.writeUInt32LE(entry.offset, 42);
            this.emit(header);
            this.emit(entry.name);
        }
        const size = this.offset - start;
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(0, 4);
        end.writeUInt16LE(0, 6);
        end.writeUInt16LE(Math.min(this.central.length, 0xffff), 8);
        end.writeUInt16LE(Math.min(this.central.length, 0xffff), 10);
        end.writeUInt32LE(size, 12);
        end.writeUInt32LE(start, 16);
        end.writeUInt16LE(0, 20);
        this.emit(end);
    }

    private closeEntry(): void {
        const entry = this.current;
        if (!entry) return;
        this.current = null;
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(entry.crc, 4);
        descriptor.writeUInt32LE(entry.size, 8);
        descriptor.writeUInt32LE(entry.size, 12);
        this.emit(descriptor);
        this.central.push({
            name: entry.name,
            crc: entry.crc,
            size: entry.size,
            offset: entry.offset,
            time: entry.time,
            date: entry.date,
            attributes: entry.attributes,
        });
    }

    private emit(chunk: Buffer): void {
        this.offset += chunk.length;
        this.write(chunk);
    }
}
