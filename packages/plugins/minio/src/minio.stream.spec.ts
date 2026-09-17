import { AwsS3StoragePlugin } from '@ever-works/aws-s3-plugin';
import { describe, expect, it } from 'vitest';
import { MinioStoragePlugin } from './minio.plugin.js';

/**
 * AW-22 needed a storage backend that can take an object whose size is not
 * known until its last byte, so the workspace-backup archive is bounded by
 * the bucket rather than by the API process's memory.
 *
 * MinIO speaks the same protocol as S3 and this plugin already extends the S3
 * one, so the correct change was none at all here beyond the manifest: the
 * multipart implementation is inherited. That is the property this file pins
 * — that there is exactly ONE implementation of streaming for both backends
 * and no fork of it appeared under `minio/` (Constitution III). The upload
 * mechanics themselves are covered in the aws-s3 package, against a mocked
 * SDK, so nothing here needs a bucket.
 */
describe('MinioStoragePlugin — inherited streaming', () => {
	it('declares both AW-22 streaming capabilities', () => {
		const plugin = new MinioStoragePlugin();
		expect(plugin.capabilities).toContain('put-object-stream');
		expect(plugin.capabilities).toContain('get-object-stream');
	});

	it('advertises them in the manifest it publishes', () => {
		const manifest = new MinioStoragePlugin().getManifest();
		expect(manifest.capabilities).toContain('put-object-stream');
		expect(manifest.capabilities).toContain('get-object-stream');
	});

	it('reuses the S3 implementation rather than forking it', () => {
		const plugin = new MinioStoragePlugin();
		expect(plugin.putObjectStream).toBe(AwsS3StoragePlugin.prototype.putObjectStream);
		expect(plugin.getObjectStream).toBe(AwsS3StoragePlugin.prototype.getObjectStream);
	});

	it('still answers the capability probe the backup accessor uses', () => {
		// The accessor resolves streaming by `typeof plugin.putObjectStream
		// === 'function'`, never by a backend id, so a new backend gets the
		// larger archive ceiling by implementing the method and nothing else.
		const plugin = new MinioStoragePlugin();
		expect(typeof plugin.putObjectStream).toBe('function');
		expect(typeof plugin.getObjectStream).toBe('function');
	});

	it('keeps the identity and the buffered surface it already had', () => {
		const plugin = new MinioStoragePlugin();
		expect(plugin.id).toBe('minio');
		expect(plugin.providerName).toBe('minio');
		expect(plugin.capabilities).toContain('put-object');
		expect(plugin.capabilities).toContain('get-object');
		expect(plugin.capabilities).toContain('presigned-put');
	});
});
