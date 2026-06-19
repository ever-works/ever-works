import type { IPlugin, ISecretStoreProvider, JsonSchema, PluginCategory, PluginContext } from '@ever-works/plugin';
import { SECRET_STORE_CAPABILITIES } from '@ever-works/plugin';

/**
 * EW-742 P3.2 T20.9 -- Doppler SecretStoreResolver plugin.
 *
 * [Doppler](https://doppler.com) is a freemium SaaS secrets-management
 * platform. This plugin fetches a Doppler config (all secrets in one
 * project+config) via the REST API and returns them as a flat bag.
 *
 * # Pointer format
 *
 *   `doppler:<project>/<config>` (e.g. `doppler:ever-works/prd_tenants_acme`)
 *
 * # Configuration
 *
 *   - `DOPPLER_TOKEN` -- Service Token or Service Account token (required)
 *
 * # Value precedence
 *
 * Each Doppler secret has both `.raw` (literal user-set) and
 * `.computed` (server-side substituted). The plugin prefers `.raw`,
 * falls back to `.computed` if missing.
 *
 * # Fail-open: every failure path returns null. Never throws.
 */
export class DopplerSecretStorePlugin implements IPlugin, ISecretStoreProvider {
	readonly id = 'secret-store-doppler';
	readonly name = 'Doppler Secret Store';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			dopplerToken: {
				type: 'string',
				title: 'Doppler Token',
				description: 'Service Token or Service Account token with read access.',
				'x-secret': true,
				'x-envVar': 'DOPPLER_TOKEN'
			}
		}
	};

	private static readonly API_HOST = 'https://api.doppler.com';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async resolveSecret(pointer: string): Promise<Record<string, unknown> | null> {
		if (!pointer.startsWith('doppler:')) {
			const scheme = pointer.split(':', 1)[0] ?? 'unknown';
			this.warn(`DopplerSecretStorePlugin: pointer scheme "${scheme}:" not handled. Returning null (fail-open).`);
			return null;
		}

		const rest = pointer.slice('doppler:'.length);
		const parsed = this.parsePointer(rest);
		if (!parsed) {
			this.warn(
				`DopplerSecretStorePlugin: malformed pointer "${pointer}" (expected ` +
					`doppler:<project>/<config>). Returning null (fail-open).`
			);
			return null;
		}

		const token = process.env.DOPPLER_TOKEN;
		if (!token) {
			this.warn(`DopplerSecretStorePlugin: DOPPLER_TOKEN not set. Returning null (fail-open).`);
			return null;
		}

		const url =
			`${DopplerSecretStorePlugin.API_HOST}/v3/configs/config/secrets` +
			`?project=${encodeURIComponent(parsed.project)}` +
			`&config=${encodeURIComponent(parsed.config)}`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
			});
		} catch (err) {
			this.warn(
				`DopplerSecretStorePlugin: fetch failed for ${url} ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (!response.ok) {
			this.warn(`DopplerSecretStorePlugin: Doppler responded ${response.status}. Returning null (fail-open).`);
			return null;
		}

		let json: unknown;
		try {
			json = await response.json();
		} catch (err) {
			this.warn(
				`DopplerSecretStorePlugin: response is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}). Returning null (fail-open).`
			);
			return null;
		}

		if (json === null || typeof json !== 'object' || Array.isArray(json)) {
			this.warn(`DopplerSecretStorePlugin: response is not a JSON object. Returning null.`);
			return null;
		}

		const secrets = (json as { secrets?: unknown }).secrets;
		if (secrets === null || secrets === undefined) {
			return {};
		}
		if (typeof secrets !== 'object' || Array.isArray(secrets)) {
			this.warn(`DopplerSecretStorePlugin: .secrets is not an object. Returning null.`);
			return null;
		}

		const bag: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(secrets as Record<string, unknown>)) {
			if (!entry || typeof entry !== 'object') continue;
			const raw = (entry as { raw?: unknown }).raw;
			const computed = (entry as { computed?: unknown }).computed;
			if (typeof raw === 'string') {
				bag[key] = raw;
			} else if (typeof computed === 'string') {
				bag[key] = computed;
			}
		}
		return bag;
	}

	private parsePointer(rest: string): { project: string; config: string } | null {
		const slashIdx = rest.indexOf('/');
		if (slashIdx <= 0) return null;
		const project = rest.slice(0, slashIdx);
		const config = rest.slice(slashIdx + 1);
		if (!project || !config) return null;
		return { project, config };
	}

	private warn(message: string): void {
		this.context?.logger?.warn?.(message) ?? console.warn(message);
	}
}
