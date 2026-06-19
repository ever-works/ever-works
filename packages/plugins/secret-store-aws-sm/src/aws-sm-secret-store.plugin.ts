import { createHash, createHmac } from 'node:crypto';
import type { IPlugin, ISecretStoreProvider, JsonSchema, PluginCategory, PluginContext } from '@ever-works/plugin';
import { SECRET_STORE_CAPABILITIES } from '@ever-works/plugin';

/**
 * EW-742 P3.2 T20.10a -- AWS Secrets Manager SecretStoreResolver plugin.
 *
 * Resolves `aws-sm:<region>/<secretName>` pointers via the AWS Secrets
 * Manager REST API. Uses AWS Signature v4 from the standard
 * `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + (optional)
 * `AWS_SESSION_TOKEN` env vars.
 *
 * # Pointer format
 *
 *   `aws-sm:<region>/<secretName>` -- e.g. `aws-sm:us-east-1/prod/tenants/acme`
 *
 * The secret name can contain slashes (AWS supports them in names).
 * Everything after the first `/` is the secret id.
 *
 * # Auth
 *
 * Uses SigV4 (no AWS SDK dependency). Operators provision AWS access
 * via the standard env-var conventions:
 *   - Static keys: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
 *   - STS / IRSA / EC2-IMDS: tooling layer (IRSA mutating webhook,
 *     `aws sts assume-role`, etc.) writes the same env vars
 *     including `AWS_SESSION_TOKEN`.
 *
 * Pure SigV4 — Node 22+ built-ins only (crypto + fetch).
 *
 * # Fail-open
 *
 * Every failure path returns null + warn. Never throws.
 */
export class AwsSmSecretStorePlugin implements IPlugin, ISecretStoreProvider {
	readonly id = 'secret-store-aws-sm';
	readonly name = 'AWS Secrets Manager Secret Store';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			awsAccessKeyId: {
				type: 'string',
				title: 'AWS Access Key Id',
				'x-envVar': 'AWS_ACCESS_KEY_ID'
			},
			awsSecretAccessKey: {
				type: 'string',
				title: 'AWS Secret Access Key',
				'x-secret': true,
				'x-envVar': 'AWS_SECRET_ACCESS_KEY'
			},
			awsSessionToken: {
				type: 'string',
				title: 'AWS Session Token (STS)',
				'x-secret': true,
				'x-envVar': 'AWS_SESSION_TOKEN'
			}
		}
	};

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async resolveSecret(pointer: string): Promise<Record<string, unknown> | null> {
		if (!pointer.startsWith('aws-sm:')) {
			const scheme = pointer.split(':', 1)[0] ?? 'unknown';
			this.warn(`AwsSmSecretStorePlugin: pointer scheme "${scheme}:" not handled. Returning null (fail-open).`);
			return null;
		}

		const rest = pointer.slice('aws-sm:'.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx <= 0) {
			this.warn(
				`AwsSmSecretStorePlugin: malformed pointer "${pointer}" (expected ` +
					`aws-sm:<region>/<secretName>). Returning null (fail-open).`
			);
			return null;
		}
		const region = rest.slice(0, slashIdx);
		const secretId = rest.slice(slashIdx + 1);
		if (!region || !secretId) {
			this.warn(`AwsSmSecretStorePlugin: empty region or secretName in "${pointer}". Returning null.`);
			return null;
		}

		const accessKey = process.env.AWS_ACCESS_KEY_ID;
		const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
		const sessionToken = process.env.AWS_SESSION_TOKEN;
		if (!accessKey || !secretKey) {
			this.warn(
				`AwsSmSecretStorePlugin: AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY not set. ` +
					`Returning null (fail-open).`
			);
			return null;
		}

		const host = `secretsmanager.${region}.amazonaws.com`;
		const url = `https://${host}/`;
		const body = JSON.stringify({ SecretId: secretId });
		const headers = this.signRequest({
			method: 'POST',
			host,
			region,
			service: 'secretsmanager',
			body,
			accessKey,
			secretKey,
			sessionToken,
			target: 'secretsmanager.GetSecretValue'
		});

		let response: Response;
		try {
			response = await fetch(url, { method: 'POST', headers, body });
		} catch (err) {
			this.warn(
				`AwsSmSecretStorePlugin: fetch failed for ${url} ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (!response.ok) {
			this.warn(`AwsSmSecretStorePlugin: AWS responded ${response.status}. Returning null.`);
			return null;
		}

		let json: { SecretString?: unknown; SecretBinary?: unknown } | unknown;
		try {
			json = await response.json();
		} catch (err) {
			this.warn(
				`AwsSmSecretStorePlugin: response is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null.`
			);
			return null;
		}

		if (json === null || typeof json !== 'object') {
			this.warn(`AwsSmSecretStorePlugin: response is not an object. Returning null.`);
			return null;
		}

		const secretString = (json as { SecretString?: unknown }).SecretString;
		if (typeof secretString === 'string') {
			try {
				const parsed = JSON.parse(secretString);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
				this.warn(`AwsSmSecretStorePlugin: SecretString is not a JSON object. Returning null.`);
				return null;
			} catch {
				this.warn(`AwsSmSecretStorePlugin: SecretString is not valid JSON. Returning null.`);
				return null;
			}
		}

		this.warn(`AwsSmSecretStorePlugin: response missing SecretString. Returning null.`);
		return null;
	}

	/**
	 * AWS Signature Version 4 (SigV4) — pure-Node implementation. Returns
	 * the headers to send with the POST request. See AWS docs:
	 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
	 */
	private signRequest(opts: {
		method: string;
		host: string;
		region: string;
		service: string;
		body: string;
		accessKey: string;
		secretKey: string;
		sessionToken?: string;
		target: string;
	}): Record<string, string> {
		const { method, host, region, service, body, accessKey, secretKey, sessionToken, target } = opts;
		const now = new Date();
		const amzDate = now
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d{3}/, '');
		const dateStamp = amzDate.slice(0, 8);

		const payloadHash = createHash('sha256').update(body).digest('hex');

		const canonicalUri = '/';
		const canonicalQuerystring = '';
		const baseHeaders: Record<string, string> = {
			'content-type': 'application/x-amz-json-1.1',
			host,
			'x-amz-date': amzDate,
			'x-amz-target': target
		};
		if (sessionToken) baseHeaders['x-amz-security-token'] = sessionToken;

		const sortedHeaderNames = Object.keys(baseHeaders).sort();
		const canonicalHeaders = sortedHeaderNames.map((k) => `${k}:${baseHeaders[k]}\n`).join('');
		const signedHeaders = sortedHeaderNames.join(';');

		const canonicalRequest = [
			method,
			canonicalUri,
			canonicalQuerystring,
			canonicalHeaders,
			signedHeaders,
			payloadHash
		].join('\n');

		const algorithm = 'AWS4-HMAC-SHA256';
		const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
		const stringToSign = [
			algorithm,
			amzDate,
			credentialScope,
			createHash('sha256').update(canonicalRequest).digest('hex')
		].join('\n');

		const kDate = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest();
		const kRegion = createHmac('sha256', kDate).update(region).digest();
		const kService = createHmac('sha256', kRegion).update(service).digest();
		const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
		const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

		const authorization =
			`${algorithm} Credential=${accessKey}/${credentialScope}, ` +
			`SignedHeaders=${signedHeaders}, Signature=${signature}`;

		const headers: Record<string, string> = {
			'Content-Type': 'application/x-amz-json-1.1',
			Host: host,
			'X-Amz-Date': amzDate,
			'X-Amz-Target': target,
			Authorization: authorization
		};
		if (sessionToken) headers['X-Amz-Security-Token'] = sessionToken;
		return headers;
	}

	private warn(message: string): void {
		this.context?.logger?.warn?.(message) ?? console.warn(message);
	}
}
