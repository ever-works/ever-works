import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsStoragePlugin } from './local-fs.plugin.js';

/**
 * AW-22 added the two optional streaming methods so an object larger than
 * memory can be written and served. The point of the pair is that the bytes
 * are never held at once, so the tests drive streams that are comfortably
 * larger than the 64 KiB chunk size the filesystem streams use, and assert
 * the round-trip is byte-exact.
 */
describe('LocalFsStoragePlugin — streaming put and get', () => {
	let dir: string;
	let plugin: LocalFsStoragePlugin;
	const previousUploadsDir = process.env.UPLOADS_DIR;

	function chunkedStream(chunk: Buffer, times: number): Readable {
		let remaining = times;
		return new Readable({
			read() {
				this.push(remaining-- > 0 ? chunk : null);
			}
		});
	}

	async function drain(stream: Readable): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
		}
		return Buffer.concat(chunks);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'ew-local-fs-stream-'));
		process.env.UPLOADS_DIR = dir;
		plugin = new LocalFsStoragePlugin();
	});

	afterEach(() => {
		if (previousUploadsDir === undefined) {
			delete process.env.UPLOADS_DIR;
		} else {
			process.env.UPLOADS_DIR = previousUploadsDir;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it('declares both streaming capabilities', () => {
		expect(plugin.capabilities).toContain('put-object-stream');
		expect(plugin.capabilities).toContain('get-object-stream');
	});

	it('round-trips a stream larger than the filesystem chunk size, byte for byte', async () => {
		// 24 chunks of 32 KiB = 768 KiB. The filesystem streams read and
		// write in 64 KiB chunks, so both halves of the round-trip cross a
		// dozen chunk boundaries — which is the property that breaks first
		// if either side ever starts buffering.
		const chunk = Buffer.alloc(32 * 1024, 0x61);
		const expected = Buffer.concat(Array.from({ length: 24 }, () => chunk));

		const put = await plugin.putObjectStream({
			stream: chunkedStream(chunk, 24),
			filename: 'everworks-backup-acme-2026-09-06-7fa39c.zip',
			mimeType: 'application/zip',
			expectedSize: expected.length,
			ownerId: 'owner-1'
		});

		const got = await plugin.getObjectStream(put.key);
		expect(got.size).toBe(expected.length);
		expect(got.mimeType).toBe('application/zip');
		// Byte for byte, via `Buffer.equals` rather than `toEqual`. They make the
		// same claim, but `toEqual` walks a Buffer element by element: measured
		// at 5.9 s for these 768 KiB on a developer machine against 1 ms for
		// `equals`, which pushed the test past its 30 s budget on a loaded CI
		// runner and reddened `main`. The first differing offset is reported on
		// a mismatch, so a failure stays as diagnosable as the diff would be.
		const actual = await drain(got.stream);
		expect(actual.length).toBe(expected.length);
		const firstDifference = actual.equals(expected) ? -1 : actual.findIndex((byte, i) => byte !== expected[i]);
		expect(firstDifference, `the round-tripped stream differs at byte ${firstDifference}`).toBe(-1);
	}, 30_000);

	it('keys the object by the digest of the streamed bytes, exactly as putObject does', async () => {
		const bytes = Buffer.from('the same bytes, written two different ways');
		const digest = createHash('sha256').update(bytes).digest('hex');

		const buffered = await plugin.putObject({
			buffer: bytes,
			filename: 'x.txt',
			mimeType: 'text/plain',
			size: bytes.length,
			ownerId: 'owner-1'
		});
		const streamed = await plugin.putObjectStream({
			stream: Readable.from([bytes]),
			filename: 'x.txt',
			mimeType: 'text/plain',
			ownerId: 'owner-1'
		});

		expect(streamed.key).toBe(buffered.key);
		expect(streamed.key).toBe(`owner-1/${digest}.txt`);
	});

	it('leaves the object readable through the existing buffered getObject', async () => {
		const bytes = Buffer.from('written as a stream, read as a buffer');
		const put = await plugin.putObjectStream({
			stream: Readable.from([bytes]),
			filename: 'note.txt',
			mimeType: 'text/plain',
			ownerId: 'owner-1'
		});

		const got = await plugin.getObject(put.key);
		expect(got.buffer).toEqual(bytes);
	});

	it('leaves no partial object behind when the source stream fails', async () => {
		const failing = new Readable({
			read() {
				this.destroy(new Error('source went away'));
			}
		});

		await expect(
			plugin.putObjectStream({
				stream: failing,
				filename: 'broken.zip',
				mimeType: 'application/zip',
				ownerId: 'owner-1'
			})
		).rejects.toThrow('source went away');

		// The temporary name is cleaned up, so a failed write never leaves a
		// file an operator has to recognise and remove by hand.
		expect(readdirSync(join(dir, 'owner-1'))).toEqual([]);
	});

	it('reports a missing key the same way the buffered read does', async () => {
		await expect(plugin.getObjectStream('owner-1/deadbeef.zip')).rejects.toThrow('Upload not found');
	});

	it('refuses a key that tries to escape its owner directory', async () => {
		await expect(plugin.getObjectStream('owner-1/../../etc/passwd')).rejects.toThrow();
	});
});
