import { AwsS3StoragePlugin, type S3Config } from '@ever-works/aws-s3-plugin';
import type {
	PluginCategory,
	PluginManifest,
	JsonSchema,
	PluginContext
} from '@ever-works/plugin';

/**
 * EW-637 — MinIO storage backend.
 *
 * Functionally identical to AWS S3 but pointed at a custom endpoint
 * (typically a self-hosted MinIO cluster) with path-style URLs forced on
 * (MinIO doesn't always support virtual-hosted-style with arbitrary
 * bucket names). We reuse `AwsS3StoragePlugin` and only override the
 * env-resolution + manifest metadata.
 */
export class MinioStoragePlugin extends AwsS3StoragePlugin {
	override readonly id = 'minio';
	override readonly name = 'MinIO';
	override readonly category: PluginCategory = 'storage';
	override readonly providerName = 'minio';

	override readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			endpoint: {
				type: 'string',
				title: 'MinIO Endpoint',
				description: 'Full endpoint URL (e.g. https://minio.example.com:9000).',
				'x-envVar': 'MINIO_ENDPOINT'
			},
			region: {
				type: 'string',
				title: 'Region Label',
				description: 'Region string sent in S3 requests. MinIO ignores it (default us-east-1).',
				default: 'us-east-1',
				'x-envVar': 'MINIO_REGION'
			},
			bucket: {
				type: 'string',
				title: 'Bucket',
				description: 'MinIO bucket name.',
				'x-envVar': 'MINIO_BUCKET'
			},
			accessKey: {
				type: 'string',
				title: 'Access Key',
				description: 'MinIO access key.',
				'x-secret': true,
				'x-envVar': 'MINIO_ACCESS_KEY'
			},
			secretKey: {
				type: 'string',
				title: 'Secret Key',
				description: 'MinIO secret key.',
				'x-secret': true,
				'x-envVar': 'MINIO_SECRET_KEY'
			},
			presignExpiresSeconds: {
				type: 'number',
				title: 'Presign URL TTL (seconds)',
				description: 'How long pre-signed upload URLs stay valid. Default 600 (10 min).',
				default: 600,
				minimum: 60,
				maximum: 3600,
				'x-envVar': 'MINIO_PRESIGN_EXPIRES_SECONDS'
			}
		},
		required: ['endpoint', 'bucket']
	};

	protected override envOverrides(): Partial<S3Config> {
		const endpoint = process.env.MINIO_ENDPOINT;
		if (!endpoint) {
			throw new Error('MINIO_ENDPOINT is not set');
		}
		return {
			endpoint,
			region: process.env.MINIO_REGION || 'us-east-1',
			bucket: process.env.MINIO_BUCKET || '',
			accessKeyId: process.env.MINIO_ACCESS_KEY,
			secretAccessKey: process.env.MINIO_SECRET_KEY,
			forcePathStyle: true,
			presignExpiresSeconds:
				Number(process.env.MINIO_PRESIGN_EXPIRES_SECONDS) || 600
		};
	}

	override async onLoad(context: PluginContext): Promise<void> {
		context.logger.log('MinIO storage plugin loaded');
	}

	override getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Self-hosted S3-compatible storage backend (MinIO).',
			category: this.category,
			capabilities: [...this.capabilities],
			builtIn: false,
			systemPlugin: false,
			icon: { type: 'lucide', value: 'Server', backgroundColor: '#c72e29' }
		};
	}
}

export default MinioStoragePlugin;
