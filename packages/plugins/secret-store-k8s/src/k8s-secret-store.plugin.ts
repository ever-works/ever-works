import { readFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import type { IPlugin, ISecretStoreProvider, JsonSchema, PluginCategory, PluginContext } from '@ever-works/plugin';
import { SECRET_STORE_CAPABILITIES } from '@ever-works/plugin';

/**
 * EW-742 P3.2 T20.7 -- Kubernetes Secret SecretStoreResolver plugin.
 *
 * Resolves `k8s:<name>` or `k8s:<namespace>/<name>` pointers via the
 * in-cluster Kubernetes API. Reads bearer token + CA cert + default
 * namespace from the service account mount at
 * `/var/run/secrets/kubernetes.io/serviceaccount/`.
 *
 * # Pointer format
 *
 *   - `k8s:<name>` -- uses the pod's own namespace
 *   - `k8s:<namespace>/<name>` -- explicit namespace
 *
 * # In-cluster requirements
 *
 *   - `KUBERNETES_SERVICE_HOST` env var (set by kubelet automatically)
 *   - `KUBERNETES_SERVICE_PORT` env var (defaults to 443 if unset)
 *   - SA mount files: token, ca.crt, namespace
 *
 * Running OUT-of-cluster (env var missing) returns null + warn --
 * local dev should use `inline:` via the in-process resolver instead.
 *
 * # Secret decoding
 *
 * Kubernetes Secrets store every value as base64. This resolver
 * decodes each `.data[key]` to UTF-8 and returns the result as
 * `Record<string, string>`. Binary secrets should be double-encoded.
 *
 * # Fail-open semantics
 *
 * Every failure path returns null -- never throws. Uses Node 22+
 * built-ins only (fs/promises.readFile + https.Agent + global fetch).
 */
export class K8sSecretStorePlugin implements IPlugin, ISecretStoreProvider {
	readonly id = 'secret-store-k8s';
	readonly name = 'Kubernetes Secret Store';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			kubernetesServiceHost: {
				type: 'string',
				title: 'Kubernetes API Server Host',
				description: 'In-cluster API server IP (set by kubelet automatically).',
				'x-envVar': 'KUBERNETES_SERVICE_HOST'
			},
			kubernetesServicePort: {
				type: 'string',
				title: 'Kubernetes API Server Port',
				description: 'In-cluster API server port. Defaults to 443.',
				'x-envVar': 'KUBERNETES_SERVICE_PORT'
			}
		}
	};

	private static readonly SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async resolveSecret(pointer: string): Promise<Record<string, unknown> | null> {
		if (!pointer.startsWith('k8s:')) {
			const scheme = pointer.split(':', 1)[0] ?? 'unknown';
			this.warn(
				`K8sSecretStorePlugin: pointer scheme "${scheme}:" not handled. Use k8s: only. ` +
					`Returning null (fail-open).`
			);
			return null;
		}

		const rest = pointer.slice('k8s:'.length);
		if (!rest) {
			this.warn(`K8sSecretStorePlugin: k8s: pointer carries empty payload. Returning null (fail-open).`);
			return null;
		}

		const host = process.env.KUBERNETES_SERVICE_HOST;
		const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
		if (!host) {
			this.warn(
				`K8sSecretStorePlugin: KUBERNETES_SERVICE_HOST not set. Running OUT-of-cluster — ` +
					`use inline: via the in-process resolver for local dev. Returning null (fail-open).`
			);
			return null;
		}

		let namespace: string;
		let name: string;
		const slashIdx = rest.indexOf('/');
		if (slashIdx >= 0) {
			namespace = rest.slice(0, slashIdx);
			name = rest.slice(slashIdx + 1);
			if (!namespace || !name) {
				this.warn(
					`K8sSecretStorePlugin: malformed pointer "${pointer}" (expected k8s:<name> ` +
						`or k8s:<ns>/<name>). Returning null (fail-open).`
				);
				return null;
			}
		} else {
			name = rest;
			const ns = await this.readSaFile('namespace');
			if (!ns) {
				return null;
			}
			namespace = ns.trim();
		}

		const token = await this.readSaFile('token');
		if (!token) {
			return null;
		}
		const ca = await this.readSaFile('ca.crt');
		if (!ca) {
			return null;
		}

		const url = `https://${host}:${port}/api/v1/namespaces/${namespace}/secrets/${name}`;
		const agent = new Agent({ ca });

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${token.trim()}`,
					Accept: 'application/json'
				},
				// @ts-expect-error -- Node's undici fetch accepts an https.Agent via `dispatcher`.
				dispatcher: agent
			});
		} catch (err) {
			this.warn(
				`K8sSecretStorePlugin: fetch failed for ${url} ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (!response.ok) {
			this.warn(
				`K8sSecretStorePlugin: API responded ${response.status} for ${url}. ` + `Returning null (fail-open).`
			);
			return null;
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (err) {
			this.warn(
				`K8sSecretStorePlugin: API response is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (json === null || typeof json !== 'object' || Array.isArray(json)) {
			this.warn(`K8sSecretStorePlugin: API response is not a JSON object. Returning null.`);
			return null;
		}

		const data = (json as { data?: unknown }).data;
		if (data === undefined || data === null) {
			return {};
		}
		if (typeof data !== 'object' || Array.isArray(data)) {
			this.warn(`K8sSecretStorePlugin: API response .data is not an object. Returning null.`);
			return null;
		}

		const decoded: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
			if (typeof value !== 'string') continue;
			try {
				decoded[key] = Buffer.from(value, 'base64').toString('utf8');
			} catch {
				continue;
			}
		}
		return decoded;
	}

	private async readSaFile(name: string): Promise<string | null> {
		try {
			return await readFile(`${K8sSecretStorePlugin.SA_PATH}/${name}`, 'utf8');
		} catch (err) {
			this.warn(
				`K8sSecretStorePlugin: failed to read ${name} from SA mount ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}
	}

	private warn(message: string): void {
		this.context?.logger?.warn?.(message) ?? console.warn(message);
	}
}
