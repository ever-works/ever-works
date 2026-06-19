import type { IPlugin, ISecretStoreProvider, JsonSchema, PluginCategory, PluginContext } from '@ever-works/plugin';
import { SECRET_STORE_CAPABILITIES } from '@ever-works/plugin';

/**
 * EW-742 P3.2 follow-up -- HashiCorp Vault SecretStoreResolver plugin.
 *
 * Resolves `vault:<path>` pointers via the HashiCorp Vault KV v1/v2
 * REST API. Operators opt in by overriding the
 * `SECRET_STORE_RESOLVER` DI binding to this plugin; the default
 * deployment keeps the in-process resolver (which handles `inline:`
 * and `env:`).
 *
 * # Pointer format
 *
 *   `vault:<path>` where `<path>` is the Vault REST path AFTER `/v1/`.
 *
 *   - `vault:secret/tenants/acme/temporal` (KV v1)
 *   - `vault:secret/data/tenants/acme/trigger` (KV v2)
 *
 * # KV version auto-detection
 *
 * Vault KV v1 returns `{ data: { key1: val1, ... } }` and KV v2 returns
 * `{ data: { data: { key1: val1, ... }, metadata: {...} } }`. This
 * resolver tries KV v2 first (`json.data.data` is a non-null object),
 * falls back to KV v1 (`json.data` is a non-null object).
 *
 * # Configuration
 *
 *   - `VAULT_ADDR` -- Vault server URL (required).
 *   - `VAULT_TOKEN` -- token with read permission on the requested
 *     paths (required).
 *
 * Both env vars are read at every {@link resolveSecret} call so
 * operators can rotate the token at runtime via pod rolling restart
 * without code changes. Missing either returns `null` + console.warn
 * (fail-open per contract).
 *
 * # Fail-open semantics
 *
 * Every failure path returns `null` -- never throws. The platform's
 * `TenantAwareRuntimeResolver` falls back to the instance default on
 * `null`, so an unreachable Vault never blocks an enqueue.
 *
 * Uses Node 22+ global `fetch` -- no new npm dependency.
 */
export class VaultSecretStorePlugin implements IPlugin, ISecretStoreProvider {
	readonly id = 'secret-store-vault';
	readonly name = 'HashiCorp Vault Secret Store';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			vaultAddr: {
				type: 'string',
				title: 'Vault Address',
				description: 'Vault server URL (e.g. https://vault.internal:8200).',
				'x-envVar': 'VAULT_ADDR'
			},
			vaultToken: {
				type: 'string',
				title: 'Vault Token',
				description: 'Vault token with read permission on the requested paths.',
				'x-secret': true,
				'x-envVar': 'VAULT_TOKEN'
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
		if (!pointer.startsWith('vault:')) {
			const scheme = pointer.split(':', 1)[0] ?? 'unknown';
			this.warn(
				`VaultSecretStorePlugin: pointer scheme "${scheme}:" not handled by this ` +
					`plugin. Use the vault: scheme for Vault. Returning null (fail-open).`
			);
			return null;
		}

		const path = pointer.slice('vault:'.length);
		if (!path) {
			this.warn(`VaultSecretStorePlugin: vault: pointer carries empty path. Returning null ` + `(fail-open).`);
			return null;
		}

		const addr = process.env.VAULT_ADDR;
		const token = process.env.VAULT_TOKEN;
		if (!addr) {
			this.warn(`VaultSecretStorePlugin: VAULT_ADDR env var not set. Returning null (fail-open).`);
			return null;
		}
		if (!token) {
			this.warn(`VaultSecretStorePlugin: VAULT_TOKEN env var not set. Returning null (fail-open).`);
			return null;
		}

		const url = `${addr.replace(/\/+$/, '')}/v1/${path.replace(/^\/+/, '')}`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: {
					'X-Vault-Token': token,
					Accept: 'application/json'
				}
			});
		} catch (err) {
			this.warn(
				`VaultSecretStorePlugin: fetch failed for ${url} ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (!response.ok) {
			this.warn(
				`VaultSecretStorePlugin: Vault responded ${response.status} for ${url}. ` +
					`Returning null (fail-open).`
			);
			return null;
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (err) {
			this.warn(
				`VaultSecretStorePlugin: Vault response is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (json === null || typeof json !== 'object' || Array.isArray(json)) {
			this.warn(`VaultSecretStorePlugin: Vault response is not a JSON object. Returning null ` + `(fail-open).`);
			return null;
		}

		const outer = (json as { data?: unknown }).data;
		if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
			const v2Inner = (outer as { data?: unknown }).data;
			if (v2Inner && typeof v2Inner === 'object' && !Array.isArray(v2Inner)) {
				return v2Inner as Record<string, unknown>;
			}
			return outer as Record<string, unknown>;
		}

		this.warn(`VaultSecretStorePlugin: Vault response missing .data field. Returning null (fail-open).`);
		return null;
	}

	private warn(message: string): void {
		this.context?.logger?.warn?.(message) ?? console.warn(message);
	}
}
