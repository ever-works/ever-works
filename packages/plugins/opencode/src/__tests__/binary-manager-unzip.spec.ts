import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { crc32 } from 'node:zlib';

// The real extractor, wrapped so a spec can tell whether it was ever reached.
const { extractSpy } = vi.hoisted(() => ({ extractSpy: vi.fn() }));
vi.mock('@electron-internal/extract-zip', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@electron-internal/extract-zip')>();
	const extract = (zipPath: string, opts: { dir: string }) => {
		extractSpy(zipPath, opts);
		return actual.extract(zipPath, opts);
	};
	return { ...actual, extract, default: extract };
});

import { unzipArchive } from '../utils/binary-manager';
import { readZipCentralDirectory } from '../utils/zip-entries';

interface ZipFixtureEntry {
	name: string;
	data?: string;
	/** Unix mode (type + permission bits); defaults to a regular 0o644 file. */
	mode?: number;
}

/** A stored (uncompressed) zip with unix modes, written the way a release tool would. */
function buildZip(entries: ZipFixtureEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const data = Buffer.from(entry.data ?? '', 'utf8');
		const mode = entry.mode ?? 0o100644;
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x21, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0x21, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE((mode << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

describe('binary-manager — zip extraction through the maintained extractor', () => {
	let sandbox: string;
	let outputDir: string;
	let archivePath: string;

	beforeEach(async () => {
		extractSpy.mockClear();
		sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-unzip-spec-'));
		outputDir = path.join(sandbox, 'out');
		await fs.mkdir(outputDir);
		archivePath = path.join(sandbox, 'release.zip');
	});

	afterEach(async () => {
		await fs.rm(sandbox, { recursive: true, force: true });
	});

	it('extracts a release archive (the binary plus data files)', async () => {
		await fs.writeFile(
			archivePath,
			buildZip([
				{ name: 'opencode', data: '#!/bin/sh\necho opencode\n', mode: 0o100755 },
				{ name: 'share/', mode: 0o040755 },
				{ name: 'share/README.txt', data: 'hello' }
			])
		);

		await unzipArchive(archivePath, outputDir);

		expect(extractSpy).toHaveBeenCalledTimes(1);
		expect(extractSpy).toHaveBeenCalledWith(archivePath, { dir: path.resolve(outputDir) });
		expect(await fs.readFile(path.join(outputDir, 'opencode'), 'utf8')).toBe('#!/bin/sh\necho opencode\n');
		expect(await fs.readFile(path.join(outputDir, 'share', 'README.txt'), 'utf8')).toBe('hello');
	});

	it('refuses a path-traversing entry and writes nothing — the extractor is never reached', async () => {
		await fs.writeFile(
			archivePath,
			buildZip([
				{ name: 'opencode', data: 'binary' },
				{ name: '../escaped.txt', data: 'pwned' }
			])
		);

		await expect(unzipArchive(archivePath, outputDir)).rejects.toThrow(
			'Refusing to extract path-traversing zip entry: ../escaped.txt'
		);
		expect(extractSpy).not.toHaveBeenCalled();
		expect(await exists(path.join(sandbox, 'escaped.txt'))).toBe(false);
		// Stricter than the old per-entry callback: the benign entry ahead of the bad one is not written either.
		expect(await exists(path.join(outputDir, 'opencode'))).toBe(false);
	});

	it('refuses an absolute entry name', async () => {
		const absolute = path.join(sandbox, 'absolute.txt').split(path.sep).join('/');
		await fs.writeFile(archivePath, buildZip([{ name: absolute, data: 'pwned' }]));

		await expect(unzipArchive(archivePath, outputDir)).rejects.toThrow('Refusing to extract');
		expect(extractSpy).not.toHaveBeenCalled();
		expect(await exists(path.join(sandbox, 'absolute.txt'))).toBe(false);
	});

	it('refuses any symlink entry (GHSA-jmr9-qjv8-65gv) before anything is written', async () => {
		await fs.writeFile(
			archivePath,
			buildZip([
				{ name: 'opencode', data: 'binary' },
				{ name: 'link', data: '../../outside', mode: 0o120777 }
			])
		);

		await expect(unzipArchive(archivePath, outputDir)).rejects.toThrow(
			'Refusing to extract symlink zip entry: link'
		);
		expect(extractSpy).not.toHaveBeenCalled();
		expect(await fs.readdir(outputDir)).toEqual([]);
	});

	it('refuses the planted same-name symlink then file pair (GHSA-7pqw-9j4j-h8q3)', async () => {
		const outsideTarget = path.join(sandbox, 'victim.txt');
		await fs.writeFile(outsideTarget, 'original');
		await fs.writeFile(
			archivePath,
			buildZip([
				{ name: 'payload', data: outsideTarget.split(path.sep).join('/'), mode: 0o120777 },
				{ name: 'payload', data: 'overwritten' }
			])
		);

		await expect(unzipArchive(archivePath, outputDir)).rejects.toThrow(
			'Refusing to extract symlink zip entry: payload'
		);
		expect(extractSpy).not.toHaveBeenCalled();
		expect(await fs.readFile(outsideTarget, 'utf8')).toBe('original');
		expect(await exists(path.join(outputDir, 'payload'))).toBe(false);
	});

	it('refuses a backslash or NUL in an entry name (what the previous zip reader refused on its own)', async () => {
		await fs.writeFile(archivePath, buildZip([{ name: '..\\..\\escaped.txt', data: 'pwned' }]));
		await expect(unzipArchive(archivePath, outputDir)).rejects.toThrow('Refusing to extract');

		await fs.writeFile(archivePath, buildZip([{ name: 'opencode\0.txt', data: 'x' }]));
		await expect(unzipArchive(archivePath, outputDir)).rejects.toThrow(
			'Refusing to extract zip entry with an unsafe name'
		);
		expect(extractSpy).not.toHaveBeenCalled();
	});

	it('refuses a file that is not a zip archive', async () => {
		await fs.writeFile(archivePath, Buffer.from('not a zip at all, just some bytes that are long enough'));

		await expect(unzipArchive(archivePath, outputDir)).rejects.toThrow(
			'Refusing to extract a malformed zip archive'
		);
		expect(extractSpy).not.toHaveBeenCalled();
	});
});

describe('readZipCentralDirectory', () => {
	it('lists every entry with its name and unix mode', () => {
		const entries = readZipCentralDirectory(
			buildZip([
				{ name: 'opencode', data: 'x', mode: 0o100755 },
				{ name: 'dir/', mode: 0o040755 },
				{ name: 'dir/link', data: 'target', mode: 0o120777 }
			])
		);

		expect(entries.map((entry) => entry.fileName)).toEqual(['opencode', 'dir/', 'dir/link']);
		expect(entries.map((entry) => (entry.externalFileAttributes >>> 16) & 0o170000)).toEqual([
			0o100000, 0o040000, 0o120000
		]);
	});

	it('finds the directory behind an archive comment', () => {
		const zip = buildZip([{ name: 'opencode', data: 'x' }]);
		const comment = Buffer.from('release notes', 'utf8');
		zip.writeUInt16LE(comment.length, zip.length - 2);

		expect(readZipCentralDirectory(Buffer.concat([zip, comment])).map((entry) => entry.fileName)).toEqual([
			'opencode'
		]);
	});

	it('throws on a truncated central directory instead of returning a partial list', () => {
		const zip = buildZip([
			{ name: 'a', data: '1' },
			{ name: 'b', data: '2' }
		]);
		// Claim three entries where two are stored.
		zip.writeUInt16LE(3, zip.length - 22 + 10);

		expect(() => readZipCentralDirectory(zip)).toThrow('Refusing to extract a malformed zip archive');
	});
});
