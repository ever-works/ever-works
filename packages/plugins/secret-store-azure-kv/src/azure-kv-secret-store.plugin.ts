import type { IPlugin, ISecretStoreProvider, JsonSchema, PluginCategory, PluginContext } from '@ever-works/plugin';
import { SECRET_STORE_CAPABILITIES } from '@ever-works/plugin';

/**
 * EW-742 P3.2 T20.10c -- Azure Key Vault SecretStoreResolver plugin.
 *
 * Resolves `azure-kv:<vaultName>/<secretName>` pointers via the Azure
 * Key Vault REST API. Uses a pre-fetched Azure AD bearer token from
 * the `AZURE_KV_TOKEN` env var.
 *
 * # Pointer format
 *
 *   `azure-kv:<vaultName>/<secretName>`
 *   e.g. `azure-kv:my-vault/prod-tenant-acme`
 *
 * # Auth
 *
 * Azure AD OAuth2 client-credentials flow requires posting to
 * `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
 * `client_id` + `client_secret` + `scope=https://vault.azure.net/.default`,
 * then using the returned access token as Bearer on the KV API. That's
 * 2 HTTP calls + token caching + expiry handling — we deliberately
 * push it to the operator's tooling layer.
 *
 * Operators provision `AZURE_KV_TOKEN` out-of-band:
 *   - Managed Identity (Azure VMs / AKS) — IMDS endpoint provides
 *     the token at `http://169.254.169.254/metadata/identity/...`
 *   - Sidecar — `az account get-access-token --resource https://vault.azure.net`
 *     refresher
 *
 * # API
 *
 *   GET https://{vaultName}.vault.azure.net/secrets/{secretName}?api-version=7.4
 *   Response: `{ value: "<secret-value>", id: "...", ... }`
 *
 * The `value` field is the raw secret. We parse it as JSON if possible
 * (matches the convention of the other resolvers); if not, returns
 * `{ value: "<raw>" }` so simple string secrets still work.
 *
 * # Fail-open — every failure path returns null.
 */
export class AzureKvSecretStorePlugin implements IPlugin, ISecretStoreProvider {
	readonly id = 'secret-store-azure-kv';
	readonly name = 'Azure Key Vault Secret Store';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			azureKvToken: {
				type: 'string',
				title: 'Azure Key Vault Access Token',
				description: 'Azure AD bearer token (scope https://vault.azure.net/.default).',
				'x-secret': true,
				'x-envVar': 'AZURE_KV_TOKEN'
			}
		}
	};

	private static readonly API_VERSION = '7.4';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async resolveSecret(pointer: string): Promise<Record<string, unknown> | null> {
		if (!pointer.startsWith('azure-kv:')) {
			const scheme = pointer.split(':', 1)[0] ?? 'unknown';
			this.warn(`AzureKvSecretStorePlugin: pointer scheme "${scheme}:" not handled. Returning null (fail-open).`);
			return null;
		}

		const rest = pointer.slice('azure-kv:'.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx <= 0) {
			this.warn(
				`AzureKvSecretStorePlugin: malformed pointer "${pointer}" (expected ` +
					`azure-kv:<vaultName>/<secretName>). Returning null (fail-open).`
			);
			return null;
		}
		const vaultName = rest.slice(0, slashIdx);
		const secretName = rest.slice(slashIdx + 1);
		if (!vaultName || !secretName) {
			this.warn(`AzureKvSecretStorePlugin: empty vaultName or secretName in "${pointer}". Returning null.`);
			return null;
		}

		const token = process.env.AZURE_KV_TOKEN;
		if (!token) {
			this.warn(
				`AzureKvSecretStorePlugin: AZURE_KV_TOKEN not set. Provision via Managed Identity, ` +
					`az cli, or sidecar. Returning null (fail-open).`
			);
			return null;
		}

		const url =
			`https://${encodeURIComponent(vaultName)}.vault.azure.net/secrets/` +
			`${encodeURIComponent(secretName)}?api-version=${AzureKvSecretStorePlugin.API_VERSION}`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
			});
		} catch (err) {
			this.warn(
				`AzureKvSecretStorePlugin: fetch failed for ${url} ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (!response.ok) {
			this.warn(`AzureKvSecretStorePlugin: Azure responded ${response.status}. Returning null.`);
			return null;
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (err) {
			this.warn(
				`AzureKvSecretStorePlugin: response is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null.`
			);
			return null;
		}

		if (json === null || typeof json !== 'object') {
			this.warn(`AzureKvSecretStorePlugin: response is not an object. Returning null.`);
			return null;
		}

		const value = (json as { value?: unknown }).value;
		if (typeof value !== 'string') {
			this.warn(`AzureKvSecretStorePlugin: response missing value string. Returning null.`);
			return null;
		}

		// Try JSON-parse first (matches convention of other resolvers
		// where secrets are JSON-encoded credential bags). If parsing
		// fails, fall back to wrapping the raw string under `{ value }`
		// so simple string secrets still work.
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// not JSON — fall through to wrap as { value }
		}
		return { value };
	}

	private warn(message: string): void {
		this.context?.logger?.warn?.(message) ?? console.warn(message);
	}
}
