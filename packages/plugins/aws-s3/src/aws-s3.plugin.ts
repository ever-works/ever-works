import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadBucketCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
	IStoragePlugin,
	StoragePutInput,
	StoragePutResult,
	StorageGetResult,
	StoragePresignInput,
	StoragePresignResult,
	IPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema
} from '@ever-works/plugin';

/**
 * EW-637 — AWS S3 storage backend.
 *
 * Stores uploaded objects in an S3 bucket. Supports browser-direct uploads
 * via presigned PUT URLs so large files (videos, archives) can bypass the
 * API process entirely.
 *
 * Configuration (resolved at putObject/presign time from env):
 *   - AWS_S3_REGION  — bucket region (e.g. us-east-1)
 *   - AWS_S3_BUCKET  — bucket name
 *   - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — credentials.
 *     When omitted, falls back to the default AWS SDK credential chain
 *     (IAM role, instance profile, ~/.aws/credentials, etc).
 *
 * Object key layout:
 *   uploads/<ownerId or _shared>/<sha256>.<ext>
 *
 * Returned URL is the standard virtual-hosted-style S3 URL. If the bucket
 * is private (recommended), the caller must fetch via the API's
 * `GET /api/uploads/:owner/:filename` route which streams through
 * `getObject`. We never return a presigned GET URL from `putObject` —
 * that would leak read access via the database.
 */
export class AwsS3StoragePlugin implements IPlugin, IStoragePlugin {
	// Use widened `string` so subclasses (MinIO) can re-declare different
	// id/name/providerName without TS narrowing to the literal value.
	readonly id: string = 'aws-s3';
	readonly name: string = 'AWS S3';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'storage';
	readonly capabilities: readonly string[] = ['storage', 'put-object', 'get-object', 'presigned-put'];

	readonly providerName: string = 'aws-s3';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			region: {
				type: 'string',
				title: 'AWS Region',
				description: 'Region of the S3 bucket (e.g. us-east-1).',
				'x-envVar': 'AWS_S3_REGION'
			},
			bucket: {
				type: 'string',
				title: 'S3 Bucket',
				description: 'Bucket name.',
				'x-envVar': 'AWS_S3_BUCKET'
			},
			accessKeyId: {
				type: 'string',
				title: 'AWS Access Key Id',
				description: 'IAM access key (omit to use the default credential chain).',
				'x-secret': true,
				'x-envVar': 'AWS_ACCESS_KEY_ID'
			},
			secretAccessKey: {
				type: 'string',
				title: 'AWS Secret Access Key',
				description: 'IAM secret (omit to use the default credential chain).',
				'x-secret': true,
				'x-envVar': 'AWS_SECRET_ACCESS_KEY'
			},
			presignExpiresSeconds: {
				type: 'number',
				title: 'Presign URL TTL (seconds)',
				description: 'How long pre-signed upload URLs stay valid. Default 600 (10 min).',
				default: 600,
				minimum: 60,
				maximum: 3600,
				'x-envVar': 'AWS_S3_PRESIGN_EXPIRES_SECONDS'
			}
		},
		required: ['region', 'bucket']
	};

	private context?: PluginContext;

	async putObject(input: StoragePutInput): Promise<StoragePutResult> {
		const cfg = this.config();
		const client = this.client(cfg);
		const key = this.buildKey(input.buffer, input.filename, input.ownerId);

		await client.send(
			new PutObjectCommand({
				Bucket: cfg.bucket,
				Key: key,
				Body: input.buffer,
				ContentType: input.mimeType,
				ContentLength: input.size
			})
		);

		const url = this.objectUrl(cfg, key);
		return { key, url };
	}

	async getObject(key: string): Promise<StorageGetResult> {
		const cfg = this.config();
		const client = this.client(cfg);
		const out = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
		const body = out.Body;
		if (!body) {
			throw new Error(`S3 GetObject returned no body for key ${key}`);
		}
		// AWS SDK v3 returns a Node Readable in node.js — read fully into a
		// buffer for the API's response stream. Browser-direct downloads
		// should go through a presigned GET (not yet exposed).
		const buffer = await streamToBuffer(body as NodeJS.ReadableStream);
		return {
			buffer,
			mimeType: out.ContentType || guessMime(key)
		};
	}

	async deleteObject(key: string): Promise<void> {
		const cfg = this.config();
		const client = this.client(cfg);
		await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
	}

	async presignPut(input: StoragePresignInput): Promise<StoragePresignResult> {
		const cfg = this.config();
		const client = this.client(cfg);
		// Use a fresh random key — the browser can't know the sha256 of its
		// own bytes ahead of time, and we don't want to round-trip them
		// through the API just to compute it. The trade-off: presigned-PUT
		// keys are NOT content-addressed.
		const key = this.buildRandomKey(input.filename, input.ownerId);
		const url = await getSignedUrl(
			client,
			new PutObjectCommand({
				Bucket: cfg.bucket,
				Key: key,
				ContentType: input.mimeType,
				ContentLength: input.size
			}),
			{ expiresIn: cfg.presignExpiresSeconds }
		);
		const expiresAt = new Date(Date.now() + cfg.presignExpiresSeconds * 1000).toISOString();
		return { url, key, expiresAt };
	}

	async isAvailable(): Promise<boolean> {
		try {
			const cfg = this.config();
			const client = this.client(cfg);
			await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
			return true;
		} catch {
			return false;
		}
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('AWS S3 storage plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const available = await this.isAvailable();
		return {
			status: available ? 'healthy' : 'unhealthy',
			message: available
				? 'S3 bucket reachable'
				: 'S3 bucket not reachable (missing config or invalid credentials)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Stores uploaded objects in AWS S3, with presigned-PUT support.',
			category: this.category,
			capabilities: [...this.capabilities],
			builtIn: false,
			systemPlugin: false,
			icon: { type: 'lucide', value: 'Cloud', backgroundColor: '#ff9900' }
		};
	}

	// ============================================================================
	// Helpers
	// ============================================================================

	protected envOverrides(): Partial<S3Config> {
		return {};
	}

	private config(): S3Config {
		const overrides = this.envOverrides();
		const region = overrides.region ?? process.env.AWS_S3_REGION ?? '';
		const bucket = overrides.bucket ?? process.env.AWS_S3_BUCKET ?? '';
		const accessKeyId = overrides.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
		const secretAccessKey = overrides.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
		const endpoint = overrides.endpoint;
		const forcePathStyle = overrides.forcePathStyle ?? false;
		const presignExpiresSeconds =
			overrides.presignExpiresSeconds ?? (Number(process.env.AWS_S3_PRESIGN_EXPIRES_SECONDS) || 600);

		if (!region || !bucket) {
			throw new Error(
				`${this.id} storage plugin not configured: region=${region || '<empty>'} bucket=${bucket || '<empty>'}`
			);
		}

		return {
			region,
			bucket,
			accessKeyId,
			secretAccessKey,
			endpoint,
			forcePathStyle,
			presignExpiresSeconds
		};
	}

	private client(cfg: S3Config): S3Client {
		const credentials =
			cfg.accessKeyId && cfg.secretAccessKey
				? {
						accessKeyId: cfg.accessKeyId,
						secretAccessKey: cfg.secretAccessKey
					}
				: undefined;

		return new S3Client({
			region: cfg.region,
			credentials,
			endpoint: cfg.endpoint,
			forcePathStyle: cfg.forcePathStyle
		});
	}

	private buildKey(buffer: Buffer, filename: string, ownerId?: string): string {
		const hash = createHash('sha256').update(buffer).digest('hex');
		const ext = sanitizeExt(filename);
		const owner = sanitizeOwner(ownerId);
		return `uploads/${owner}/${hash}${ext}`;
	}

	private buildRandomKey(filename: string, ownerId?: string): string {
		const ext = sanitizeExt(filename);
		const owner = sanitizeOwner(ownerId);
		return `uploads/${owner}/${randomUUID()}${ext}`;
	}

	protected objectUrl(cfg: S3Config, key: string): string {
		if (cfg.endpoint) {
			// MinIO / custom endpoint — path-style URL.
			const base = cfg.endpoint.replace(/\/$/, '');
			return `${base}/${cfg.bucket}/${key}`;
		}
		return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`;
	}
}

// ============================================================================
// Shared helpers (also used by the MinIO subclass)
// ============================================================================

export interface S3Config {
	region: string;
	bucket: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	endpoint?: string;
	forcePathStyle?: boolean;
	presignExpiresSeconds: number;
}

export function sanitizeExt(filename: string): string {
	const e = extname(filename || '').toLowerCase();
	if (!/^\.[a-z0-9]{1,8}$/.test(e)) return '';
	return e;
}

export function sanitizeOwner(ownerId: string | undefined): string {
	if (!ownerId) return '_shared';
	// S3 keys allow slashes, but we restrict the OWNER segment to the same
	// alphabet local-fs uses so the abstraction's key shape is portable.
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) {
		throw new Error('Invalid ownerId for S3 storage');
	}
	return ownerId;
}

export function guessMime(key: string): string {
	const ext = extname(key).toLowerCase();
	switch (ext) {
		case '.png':
			return 'image/png';
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		case '.gif':
			return 'image/gif';
		case '.webp':
			return 'image/webp';
		case '.pdf':
			return 'application/pdf';
		case '.txt':
			return 'text/plain';
		case '.json':
			return 'application/json';
		default:
			return 'application/octet-stream';
	}
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	return await new Promise<Buffer>((resolveP, rejectP) => {
		stream.on('data', (chunk: Buffer | string) => {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		});
		stream.on('end', () => resolveP(Buffer.concat(chunks)));
		stream.on('error', rejectP);
	});
}

export default AwsS3StoragePlugin;
