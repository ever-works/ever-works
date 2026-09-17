/**
 * A minimal S3 client with AWS Signature Version 4, on `node:crypto` and the global `fetch`.
 *
 * Used by `GET /state` when the `all-dependencies` profile gives the fixture an `objectStorage`
 * dependency (blueprint README, profiles/all-dependencies.works.yml). It implements exactly the three
 * operations the round trip needs — `PutObject`, `GetObject`, `DeleteObject` — with path-style or
 * virtual-host addressing, so it works against MinIO and against AWS S3.
 */

import crypto from 'node:crypto';

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** @param {NodeJS.ProcessEnv} env */
export function s3Config(env = process.env) {
	const endpoint = env.S3_ENDPOINT || env.OBJECT_STORAGE_ENDPOINT || '';
	const accessKeyId = env.S3_ACCESS_KEY_ID || env.OBJECT_STORAGE_ACCESS_KEY_ID || '';
	const secretAccessKey = env.S3_SECRET_ACCESS_KEY || env.OBJECT_STORAGE_SECRET_ACCESS_KEY || '';
	const bucket = env.S3_BUCKET || env.OBJECT_STORAGE_BUCKET || (env.S3_BUCKETS || '').split(',')[0] || '';
	if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
	return {
		endpoint,
		accessKeyId,
		secretAccessKey,
		bucket: bucket.trim(),
		region: env.S3_REGION || env.OBJECT_STORAGE_REGION || 'us-east-1',
		// MinIO and most in-cluster gateways need path style; virtual-host style is the AWS default.
		pathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE !== '0' : true,
		timeoutMs: numberOr(env.FIXTURE_S3_TIMEOUT_MS, 4_000)
	};
}

export class S3Client {
	/** @param {ReturnType<typeof s3Config>} config */
	constructor(config) {
		this.config = config;
		const url = new URL(config.endpoint);
		this.base = url;
	}

	#urlFor(bucket, key) {
		const base = this.base;
		if (this.config.pathStyle) {
			const prefix = base.pathname.replace(/\/$/, '');
			return `${base.origin}${prefix}/${bucket}${key ? `/${encodeS3Key(key)}` : ''}`;
		}
		const prefix = base.pathname.replace(/\/$/, '');
		return `${base.protocol}//${bucket}.${base.host}${prefix}${key ? `/${encodeS3Key(key)}` : ''}`;
	}

	/** @param {string} method @param {string} bucket @param {string} key @param {Buffer|string} [body] */
	async request(method, bucket, key, body) {
		const target = new URL(this.#urlFor(bucket, key));
		const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
		const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
		const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
		const dateStamp = amzDate.slice(0, 8);

		/** @type {Record<string, string>} */
		const headers = {
			host: target.host,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate
		};
		if (body !== undefined) headers['content-length'] = String(payload.length);

		const signedHeaderNames = Object.keys(headers).sort();
		const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
		const signedHeaders = signedHeaderNames.join(';');
		const canonicalRequest = [
			method,
			target.pathname,
			canonicalQuery(target),
			canonicalHeaders,
			signedHeaders,
			payloadHash
		].join('\n');

		const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
		const stringToSign = [
			'AWS4-HMAC-SHA256',
			amzDate,
			scope,
			crypto.createHash('sha256').update(canonicalRequest).digest('hex')
		].join('\n');

		const signingKey = deriveSigningKey(this.config.secretAccessKey, dateStamp, this.config.region, 's3');
		const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
		headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

		const response = await fetch(target, {
			method,
			headers,
			body: body === undefined ? undefined : payload,
			signal: AbortSignal.timeout(this.config.timeoutMs)
		});
		const text = await response.text().catch(() => '');
		return { status: response.status, ok: response.ok, body: text };
	}

	putObject(key, body) {
		return this.request('PUT', this.config.bucket, key, body);
	}

	async getObject(key) {
		const result = await this.request('GET', this.config.bucket, key);
		return result;
	}

	deleteObject(key) {
		return this.request('DELETE', this.config.bucket, key);
	}
}

/**
 * Prove the dependency end to end: write one small object, read it back, compare, delete it.
 * @returns {Promise<{ok: boolean, detail: string, ms: number, bucket?: string, key?: string}>}
 */
export async function bucketRoundTrip(env = process.env, keyPrefix = 'app-fixture-hello') {
	const started = Date.now();
	const config = s3Config(env);
	if (!config) return { ok: false, detail: 'object storage is not configured (S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET)', ms: 0 };
	const client = new S3Client(config);
	const key = `${keyPrefix}/${Date.now()}-${process.pid}.txt`;
	const token = `app-fixture-hello ${new Date().toISOString()}`;
	try {
		const put = await client.putObject(key, token);
		if (!put.ok) return { ok: false, detail: `PUT ${key} answered ${put.status}: ${truncate(put.body)}`, ms: Date.now() - started, bucket: config.bucket, key };
		const got = await client.getObject(key);
		if (!got.ok) return { ok: false, detail: `GET ${key} answered ${got.status}: ${truncate(got.body)}`, ms: Date.now() - started, bucket: config.bucket, key };
		const deleted = await client.deleteObject(key);
		if (!deleted.ok) return { ok: false, detail: `DELETE ${key} answered ${deleted.status}: ${truncate(deleted.body)}`, ms: Date.now() - started, bucket: config.bucket, key };
		const ok = got.body === token;
		return {
			ok,
			detail: ok ? 'PUT, GET and DELETE all answered' : 'the object read back did not match the one written',
			ms: Date.now() - started,
			bucket: config.bucket,
			key
		};
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started, bucket: config.bucket, key };
	}
}

function canonicalQuery(url) {
	const entries = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

function encodeS3Key(key) {
	return String(key)
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

function deriveSigningKey(secret, dateStamp, region, service) {
	const kDate = crypto.createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
	const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
	const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
	return crypto.createHmac('sha256', kService).update('aws4_request').digest();
}

function truncate(text, length = 200) {
	const value = String(text || '').replace(/\s+/g, ' ').trim();
	return value.length > length ? `${value.slice(0, length)}…` : value;
}

function numberOr(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export { UNSIGNED_PAYLOAD };
