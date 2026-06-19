import type { IPlugin, ISecretStoreProvider, JsonSchema, PluginCategory, PluginContext } from '@ever-works/plugin';
import { SECRET_STORE_CAPABILITIES } from '@ever-works/plugin';

/**
 * EW-742 P3.2 T20.10b -- GCP Secret Manager SecretStoreResolver plugin.
 *
 * Resolves `gcp-sm:<project>/<secretName>` pointers via the GCP Secret
 * Manager REST API. Uses a pre-fetched OAuth2 bearer token from the
 * `GCP_ACCESS_TOKEN` env var.
 *
 * # Pointer format
 *
 *   `gcp-sm:<projectId>/<secretName>` — fetches the `latest` version.
 *
 * # Auth
 *
 * GCP OAuth2 requires JWT-signing a service-account key to obtain an
 * access token. That's an entire flow we deliberately push to the
 * operator's tooling layer (the SDK does it under the hood, but doing
 * it from scratch here would add ~150 LoC of JWT/crypto code + key
 * loading).
 *
 * Operators provision GCP_ACCESS_TOKEN out-of-band:
 *   - Workload Identity (GKE) — auto-mounted token at
 *     `/var/run/secrets/tokens/gcp-token`
 *   - Sidecar — `gcloud auth print-access-token` refresher
 *   - Service account JSON + cron — refresh via the metadata server
 *
 * # API
 *
 *   GET https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{name}/versions/latest:access
 *   Response: `{ payload: { data: "<base64-string>" } }`
 *
 * # Fail-open — every failure path returns null.
 */
export class GcpSmSecretStorePlugin implements IPlugin, ISecretStoreProvider {
	readonly id = 'secret-store-gcp-sm';
	readonly name = 'GCP Secret Manager Secret Store';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			gcpAccessToken: {
				type: 'string',
				title: 'GCP Access Token',
				description: 'OAuth2 access token with secretmanager.secretAccessor role.',
				'x-secret': true,
				'x-envVar': 'GCP_ACCESS_TOKEN'
			}
		}
	};

	private static readonly API_HOST = 'https://secretmanager.googleapis.com';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async resolveSecret(pointer: string): Promise<Record<string, unknown> | null> {
		if (!pointer.startsWith('gcp-sm:')) {
			const scheme = pointer.split(':', 1)[0] ?? 'unknown';
			this.warn(`GcpSmSecretStorePlugin: pointer scheme "${scheme}:" not handled. Returning null (fail-open).`);
			return null;
		}

		const rest = pointer.slice('gcp-sm:'.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx <= 0) {
			this.warn(
				`GcpSmSecretStorePlugin: malformed pointer "${pointer}" (expected ` +
					`gcp-sm:<project>/<secretName>). Returning null (fail-open).`
			);
			return null;
		}
		const project = rest.slice(0, slashIdx);
		const secretName = rest.slice(slashIdx + 1);
		if (!project || !secretName) {
			this.warn(`GcpSmSecretStorePlugin: empty project or secretName in "${pointer}". Returning null.`);
			return null;
		}

		const token = process.env.GCP_ACCESS_TOKEN;
		if (!token) {
			this.warn(
				`GcpSmSecretStorePlugin: GCP_ACCESS_TOKEN not set. Provision via Workload Identity, ` +
					`gcloud, or a sidecar refresher. Returning null (fail-open).`
			);
			return null;
		}

		const url =
			`${GcpSmSecretStorePlugin.API_HOST}/v1/projects/${encodeURIComponent(project)}` +
			`/secrets/${encodeURIComponent(secretName)}/versions/latest:access`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
			});
		} catch (err) {
			this.warn(
				`GcpSmSecretStorePlugin: fetch failed for ${url} ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (!response.ok) {
			this.warn(`GcpSmSecretStorePlugin: GCP responded ${response.status}. Returning null.`);
			return null;
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (err) {
			this.warn(
				`GcpSmSecretStorePlugin: response is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null.`
			);
			return null;
		}

		if (json === null || typeof json !== 'object') {
			this.warn(`GcpSmSecretStorePlugin: response is not an object. Returning null.`);
			return null;
		}

		const payload = (json as { payload?: { data?: unknown } }).payload;
		const data = payload?.data;
		if (typeof data !== 'string') {
			this.warn(`GcpSmSecretStorePlugin: response missing payload.data string. Returning null.`);
			return null;
		}

		// payload.data is base64-encoded — decode to utf8 then parse as JSON.
		let decoded: string;
		try {
			decoded = Buffer.from(data, 'base64').toString('utf8');
		} catch (err) {
			this.warn(
				`GcpSmSecretStorePlugin: payload.data base64-decode failed ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null.`
			);
			return null;
		}

		try {
			const parsed = JSON.parse(decoded);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			this.warn(`GcpSmSecretStorePlugin: decoded payload is not a JSON object. Returning null.`);
			return null;
		} catch {
			this.warn(`GcpSmSecretStorePlugin: decoded payload is not valid JSON. Returning null.`);
			return null;
		}
	}

	private warn(message: string): void {
		this.context?.logger?.warn?.(message) ?? console.warn(message);
	}
}
