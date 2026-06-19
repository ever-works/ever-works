import type { IPlugin, ISecretStoreProvider, JsonSchema, PluginCategory, PluginContext } from '@ever-works/plugin';
import { SECRET_STORE_CAPABILITIES } from '@ever-works/plugin';

/**
 * EW-742 P3.2 T20.8 -- Infisical SecretStoreResolver plugin.
 *
 * [Infisical](https://infisical.com) is an OSS secrets-management
 * platform (self-hostable + SaaS). This plugin fetches a folder of
 * secrets via the REST API and returns them as a flat credential bag.
 *
 * # Pointer format
 *
 *   `infisical:<workspaceId>/<environment>/<secretPath>`
 *
 *   - `infisical:ws-abc/prod/tenants/acme` -> path `/tenants/acme`
 *   - `infisical:ws-abc/prod/` -> path `/` (root)
 *
 * # Configuration
 *
 *   - `INFISICAL_TOKEN` -- service token / Machine Identity token (required)
 *   - `INFISICAL_HOST` -- self-hosted base URL (optional; defaults to https://app.infisical.com)
 *
 * # Fail-open
 *
 * Every failure path returns null -- never throws.
 */
export class InfisicalSecretStorePlugin implements IPlugin, ISecretStoreProvider {
	readonly id = 'secret-store-infisical';
	readonly name = 'Infisical Secret Store';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			infisicalToken: {
				type: 'string',
				title: 'Infisical Token',
				description: 'Service Token or Machine Identity token with read access.',
				'x-secret': true,
				'x-envVar': 'INFISICAL_TOKEN'
			},
			infisicalHost: {
				type: 'string',
				title: 'Infisical Host',
				description: 'Base URL for self-hosted instances. Defaults to https://app.infisical.com.',
				'x-envVar': 'INFISICAL_HOST'
			}
		}
	};

	private static readonly DEFAULT_HOST = 'https://app.infisical.com';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async resolveSecret(pointer: string): Promise<Record<string, unknown> | null> {
		if (!pointer.startsWith('infisical:')) {
			const scheme = pointer.split(':', 1)[0] ?? 'unknown';
			this.warn(
				`InfisicalSecretStorePlugin: pointer scheme "${scheme}:" not handled. ` + `Returning null (fail-open).`
			);
			return null;
		}

		const rest = pointer.slice('infisical:'.length);
		const parsed = this.parsePointer(rest);
		if (!parsed) {
			this.warn(
				`InfisicalSecretStorePlugin: malformed pointer "${pointer}" (expected ` +
					`infisical:<workspaceId>/<env>/<path>). Returning null (fail-open).`
			);
			return null;
		}

		const token = process.env.INFISICAL_TOKEN;
		if (!token) {
			this.warn(`InfisicalSecretStorePlugin: INFISICAL_TOKEN not set. Returning null (fail-open).`);
			return null;
		}

		const host = (process.env.INFISICAL_HOST ?? InfisicalSecretStorePlugin.DEFAULT_HOST).replace(/\/+$/, '');
		const url =
			`${host}/api/v3/secrets/raw?workspaceId=${encodeURIComponent(parsed.workspaceId)}` +
			`&environment=${encodeURIComponent(parsed.environment)}` +
			`&secretPath=${encodeURIComponent(parsed.secretPath)}`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
			});
		} catch (err) {
			this.warn(
				`InfisicalSecretStorePlugin: fetch failed for ${url} ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (!response.ok) {
			this.warn(
				`InfisicalSecretStorePlugin: Infisical responded ${response.status}. Returning null (fail-open).`
			);
			return null;
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (err) {
			this.warn(
				`InfisicalSecretStorePlugin: response is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (json === null || typeof json !== 'object' || Array.isArray(json)) {
			this.warn(`InfisicalSecretStorePlugin: response is not a JSON object. Returning null.`);
			return null;
		}

		const secrets = (json as { secrets?: unknown }).secrets;
		if (!Array.isArray(secrets)) {
			this.warn(`InfisicalSecretStorePlugin: response missing .secrets array. Returning null (fail-open).`);
			return null;
		}

		const bag: Record<string, unknown> = {};
		for (const secret of secrets) {
			if (!secret || typeof secret !== 'object') continue;
			const key = (secret as { secretKey?: unknown }).secretKey;
			const value = (secret as { secretValue?: unknown }).secretValue;
			if (typeof key === 'string' && typeof value === 'string') {
				bag[key] = value;
			}
		}
		return bag;
	}

	private parsePointer(rest: string): { workspaceId: string; environment: string; secretPath: string } | null {
		const firstSlash = rest.indexOf('/');
		if (firstSlash <= 0) return null;
		const workspaceId = rest.slice(0, firstSlash);
		const afterWs = rest.slice(firstSlash + 1);
		const secondSlash = afterWs.indexOf('/');
		if (secondSlash <= 0) return null;
		const environment = afterWs.slice(0, secondSlash);
		const pathRaw = afterWs.slice(secondSlash + 1);
		const secretPath = pathRaw ? (pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`) : '/';
		return { workspaceId, environment, secretPath };
	}

	private warn(message: string): void {
		this.context?.logger?.warn?.(message) ?? console.warn(message);
	}
}
