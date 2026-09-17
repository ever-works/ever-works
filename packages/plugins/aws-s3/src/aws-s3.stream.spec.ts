import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AW-22 added the two optional streaming methods so an object whose size is
 * not known up front — a workspace-backup archive — can be written and served
 * without ever being held in memory.
 *
 * The property worth testing here is not "S3 works": it is that THIS plugin
 * hands the caller's stream straight to the SDK's multipart uploader instead
 * of quietly buffering it, which would satisfy the signature while defeating
 * the whole reason the method exists. So the SDK is mocked and the assertions
 * are about what the plugin passes it.
 */

const uploads: Array<{
	params: Record<string, unknown>;
	partSize?: number;
	queueSize?: number;
	leavePartsOnError?: boolean;
	drained: Promise<Buffer>;
}> = [];

let sendImpl: (command: unknown) => Promise<unknown> = async () => ({});

vi.mock('@aws-sdk/lib-storage', () => ({
	Upload: class {
		private readonly record: (typeof uploads)[number];

		constructor(options: {
			params: Record<string, unknown>;
			partSize?: number;
			queueSize?: number;
			leavePartsOnError?: boolean;
		}) {
			const body = options.params.Body as Readable;
			this.record = {
				params: options.params,
				...(options.partSize !== undefined ? { partSize: options.partSize } : {}),
				...(options.queueSize !== undefined ? { queueSize: options.queueSize } : {}),
				...(options.leavePartsOnError !== undefined ? { leavePartsOnError: options.leavePartsOnError } : {}),
				drained: (async () => {
					const chunks: Buffer[] = [];
					for await (const chunk of body) {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
					}
					return Buffer.concat(chunks);
				})()
			};
			uploads.push(this.record);
		}

		async done() {
			await this.record.drained;
			return {};
		}
	}
}));

vi.mock('@aws-sdk/client-s3', () => {
	class Command {
		constructor(readonly input: Record<string, unknown>) {}
	}
	return {
		S3Client: class {
			send(command: unknown) {
				return sendImpl(command);
			}
		},
		PutObjectCommand: class extends Command {},
		GetObjectCommand: class extends Command {},
		DeleteObjectCommand: class extends Command {},
		DeleteObjectsCommand: class extends Command {},
		ListObjectsV2Command: class extends Command {},
		HeadBucketCommand: class extends Command {}
	};
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
	getSignedUrl: async () => 'https://example.invalid/presigned'
}));

const { AwsS3StoragePlugin } = await import('./aws-s3.plugin.js');

describe('AwsS3StoragePlugin — streaming put and get', () => {
	const previous = {
		region: process.env.AWS_S3_REGION,
		bucket: process.env.AWS_S3_BUCKET
	};

	/** A stream comfortably larger than the 8 MiB part size the plugin asks for. */
	function chunkedStream(chunk: Buffer, times: number): Readable {
		let remaining = times;
		return new Readable({
			read() {
				this.push(remaining-- > 0 ? chunk : null);
			}
		});
	}

	beforeEach(() => {
		uploads.length = 0;
		sendImpl = async () => ({});
		process.env.AWS_S3_REGION = 'us-east-1';
		process.env.AWS_S3_BUCKET = 'ew-test-bucket';
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(previous)) {
			const name = key === 'region' ? 'AWS_S3_REGION' : 'AWS_S3_BUCKET';
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it('declares both streaming capabilities and implements both methods', () => {
		const plugin = new AwsS3StoragePlugin();
		expect(plugin.capabilities).toContain('put-object-stream');
		expect(plugin.capabilities).toContain('get-object-stream');
		// The capability probe the backup accessor uses is `typeof fn ===
		// 'function'`, never a backend id — so the methods must really be there.
		expect(typeof plugin.putObjectStream).toBe('function');
		expect(typeof plugin.getObjectStream).toBe('function');
	});

	it('streams a body larger than one part through the SDK multipart uploader', async () => {
		const plugin = new AwsS3StoragePlugin();
		const chunk = Buffer.alloc(1024 * 1024, 7);
		const result = await plugin.putObjectStream({
			stream: chunkedStream(chunk, 12),
			filename: 'everworks-backup-acme-2026-09-17-abc123.zip',
			mimeType: 'application/zip'
		});

		expect(uploads).toHaveLength(1);
		const upload = uploads[0]!;
		// Handed over as a stream — not a Buffer, not a string.
		expect(Buffer.isBuffer(upload.params.Body)).toBe(false);
		expect(upload.params.Bucket).toBe('ew-test-bucket');
		expect(upload.params.ContentType).toBe('application/zip');
		// Above S3's 5 MiB minimum part size, and a bounded in-flight window.
		expect(upload.partSize).toBeGreaterThanOrEqual(5 * 1024 * 1024);
		expect(upload.queueSize).toBeGreaterThan(0);
		// A torn write must not leave billable orphan parts in the bucket.
		expect(upload.leavePartsOnError).toBe(false);

		// Every byte arrived, in order.
		const uploaded = await upload.drained;
		expect(uploaded.byteLength).toBe(chunk.byteLength * 12);
		expect(uploaded.subarray(0, 8).every((byte) => byte === 7)).toBe(true);

		// The key keeps the extension and the owner prefix shape.
		expect(result.key).toMatch(/\.zip$/);
		expect(result.url).toContain(result.key);
	});

	it('prefixes the key with the owner when one is given, and never reuses it', async () => {
		const plugin = new AwsS3StoragePlugin();
		const put = () =>
			plugin.putObjectStream({
				stream: Readable.from([Buffer.from('a')]),
				filename: 'archive.zip',
				mimeType: 'application/zip',
				ownerId: 'user-1'
			});

		const first = await put();
		const second = await put();

		expect(first.key).toContain('user-1/');
		// A streamed key cannot be content-addressed — the digest is not known
		// until the last byte — so two writes must not collide.
		expect(first.key).not.toBe(second.key);
	});

	it('hands the object body back as a stream with its length', async () => {
		const plugin = new AwsS3StoragePlugin();
		sendImpl = async () => ({
			Body: Readable.from([Buffer.from('zip-bytes')]),
			ContentType: 'application/zip',
			ContentLength: 9
		});

		const out = await plugin.getObjectStream('uploads/user-1/archive.zip');
		expect(out.mimeType).toBe('application/zip');
		expect(out.size).toBe(9);

		const chunks: Buffer[] = [];
		for await (const chunk of out.stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
		}
		expect(Buffer.concat(chunks).toString()).toBe('zip-bytes');
	});

	it('refuses a missing body rather than returning an empty stream', async () => {
		const plugin = new AwsS3StoragePlugin();
		sendImpl = async () => ({ Body: undefined });
		await expect(plugin.getObjectStream('uploads/user-1/gone.zip')).rejects.toThrow(/no body/i);
	});

	it('leaves the buffered put and get exactly as they were', async () => {
		// Program rule: nothing that worked before may work differently. The
		// two new methods are additions beside `putObject`/`getObject`, which
		// still take and return a Buffer and still content-address the key.
		const plugin = new AwsS3StoragePlugin();
		sendImpl = async () => ({});
		const put = await plugin.putObject({
			buffer: Buffer.from('abc'),
			filename: 'a.txt',
			mimeType: 'text/plain',
			size: 3,
			ownerId: 'user-1'
		});
		// sha256('abc') — still the content address, unchanged.
		expect(put.key).toBe('uploads/user-1/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.txt');
		// No multipart upload was involved in the buffered path.
		expect(uploads).toHaveLength(0);
	});
});
