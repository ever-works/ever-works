import type {
	DnsEnsureRecordInput,
	DnsRecordSnapshot,
	DnsRecordType,
	DnsRemoveRecordInput,
	IDnsProvider,
	IPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginSettings
} from '@ever-works/plugin';

import { cloudflareDnsSettingsSchema, type CloudflareDnsSettings } from './settings.schema.js';

/**
 * EW-738 — `@ever-works/cloudflare-dns` plugin.
 *
 * Wraps the Cloudflare v4 REST API behind the `IDnsProvider` capability
 * contract (EW-735). Supports both operator modes:
 *
 *   - **Managed** — platform's own zone (`ever.works`). Credentials come
 *     from `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` env vars resolved
 *     through the `x-envVar` fallbacks declared on the settings schema.
 *   - **Bring-your-own** — user-supplied token + zone for a custom domain.
 *     Values flow in via encrypted user-scoped plugin settings.
 *
 * Additive — this plugin coexists with the legacy
 * `CloudflareDnsProvider` in `@ever-works/agent`. The new
 * `PluginRegistryService` resolution path prefers the plugin when present
 * and falls back to the legacy provider otherwise.
 */
export class CloudflareDnsPlugin implements IPlugin, IDnsProvider {
	readonly id = 'cloudflare-dns';
	readonly name = 'Cloudflare DNS';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'dns';
	readonly capabilities: readonly string[] = [
		'dns',
		'dns-ensure-record',
		'dns-remove-record',
		'dns-record-exists',
		'dns-root-domain'
	];
	readonly providerName = 'cloudflare';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	readonly settingsSchema: JsonSchema = cloudflareDnsSettingsSchema;

	/**
	 * Default base URL. Overridable per-call (or via a test override) — the
	 * Cloudflare staging mirror occasionally needs a different host.
	 */
	private static readonly DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

	private context?: PluginContext;

	/** Test seam — tests can inject a custom fetch impl. */
	constructor(private readonly fetchImpl: typeof fetch = fetch) {}

	// IPlugin lifecycle -----------------------------------------------------

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Cloudflare DNS plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Cloudflare DNS plugin is ready (zone reachability is per-token)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Manage Cloudflare DNS records for managed *.ever.works subdomains and bring-your-own custom zones',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'user-only',
			distribution: 'registry',
			uiHints: {
				completionFields: ['apiToken', 'zoneId']
			},
			readme: [
				'## What is the Cloudflare DNS plugin?',
				'',
				'This plugin lets Ever Works create, update, and remove DNS records on Cloudflare for the subdomains and custom domains your Works are served from.',
				'',
				'## Modes',
				'',
				'- **Managed** — the platform automatically claims `<slug>.ever.works` for every Work you deploy. Operator-side; credentials live in env vars (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `EVER_WORKS_DEPLOY_LB_HOSTNAME`).',
				'- **Bring your own** — connect a Cloudflare token + zone for a domain you own (e.g. `acme.com`). Records are created with the proxy off by default so you can keep serving your own TLS.',
				'',
				'## Required scopes',
				'',
				'The Cloudflare API token must include `DNS:Edit` for the target zone. Create one at https://dash.cloudflare.com/profile/api-tokens.'
			].join('\n'),
			homepage: 'https://dash.cloudflare.com'
		};
	}

	// IDnsOperations contract ------------------------------------------------

	async ensureRecord(input: DnsEnsureRecordInput): Promise<DnsRecordSnapshot> {
		const settings = await this.resolveSettings();
		const host = this.normalizeHost(input.host);
		const proxied = input.proxied ?? settings.proxied ?? false;
		const ttl = input.ttl ?? 1;
		const existing = await this.findRecord(settings, host, input.type);
		if (existing) {
			if (existing.content === input.target && existing.type === input.type) {
				this.log(`Cloudflare DNS ${input.type} already in sync ${host} -> ${input.target}`);
				return existing;
			}
			const updated = await this.patchRecord(settings, existing.id, {
				type: input.type,
				name: host,
				content: input.target,
				proxied,
				ttl
			});
			this.log(
				`Cloudflare DNS ${input.type} updated ${host}: was ${existing.content} now ${input.target}`
			);
			return updated;
		}
		const created = await this.createRecord(settings, {
			type: input.type,
			name: host,
			content: input.target,
			proxied,
			ttl
		});
		this.log(`Cloudflare DNS ${input.type} created ${host} -> ${input.target}`);
		return created;
	}

	async removeRecord(input: DnsRemoveRecordInput): Promise<void> {
		const settings = await this.resolveSettings();
		const host = this.normalizeHost(input.host);
		const typesToProbe: DnsRecordType[] = input.type ? [input.type] : ['CNAME', 'A'];
		for (const type of typesToProbe) {
			const existing = await this.findRecord(settings, host, type);
			if (existing) {
				await this.deleteRecord(settings, existing.id);
				this.log(`Cloudflare DNS ${existing.type} deleted ${host} (id=${existing.id})`);
			}
		}
	}

	async recordExists(host: string): Promise<boolean> {
		const settings = await this.resolveSettings();
		const normalized = this.normalizeHost(host);
		const cname = await this.findRecord(settings, normalized, 'CNAME');
		if (cname) return true;
		const a = await this.findRecord(settings, normalized, 'A');
		return a !== null;
	}

	rootDomain(): string {
		// Resolution happens asynchronously, so this is a sync best-effort
		// view. When the plugin has been loaded with a context we mirror the
		// cached settings; otherwise we fall back to the schema default.
		return this.cachedSettings?.rootDomain ?? 'ever.works';
	}

	// Settings + auth -------------------------------------------------------

	private cachedSettings?: CloudflareDnsSettings;

	/**
	 * Resolve settings via PluginContext when available so user/work-scoped
	 * values + env-var fallbacks (`x-envVar`) are merged consistently with
	 * the rest of the plugin system. Falls back to reading the env vars
	 * directly so the plugin remains usable from bootstrap contexts that
	 * haven't yet wired a `PluginContext` (tests, CLI tools).
	 */
	private async resolveSettings(): Promise<CloudflareDnsSettings> {
		const fromContext = await this.readContextSettings();
		const apiToken = (fromContext.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
		const zoneId = (fromContext.zoneId ?? process.env.CLOUDFLARE_ZONE_ID ?? '').trim();
		const rootDomain = (fromContext.rootDomain ?? process.env.EVER_WORKS_DOMAIN ?? 'ever.works').trim();
		const targetHostname = (
			fromContext.targetHostname ??
			process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME ??
			''
		).trim();
		const proxied = fromContext.proxied ?? true;

		if (!apiToken) {
			throw new Error('Cloudflare DNS plugin: apiToken is required');
		}
		if (!zoneId) {
			throw new Error('Cloudflare DNS plugin: zoneId is required');
		}
		const settings: CloudflareDnsSettings = {
			apiToken,
			zoneId,
			rootDomain,
			targetHostname,
			proxied
		};
		this.cachedSettings = settings;
		return settings;
	}

	private async readContextSettings(): Promise<Partial<CloudflareDnsSettings>> {
		if (!this.context) return {};
		try {
			// `getResolvedSettings` merges user > work > admin > env > defaults
			// per `SETTING_SOURCE_PRIORITY`.
			const resolved = await this.context.getResolvedSettings();
			return this.coerceSettings(resolved);
		} catch {
			try {
				const raw = await this.context.getSettings();
				return this.coerceSettings(raw);
			} catch {
				return {};
			}
		}
	}

	private coerceSettings(bag: PluginSettings | Record<string, unknown> | null | undefined): Partial<CloudflareDnsSettings> {
		if (!bag || typeof bag !== 'object') return {};
		const record = bag as Record<string, unknown>;
		const out: Partial<CloudflareDnsSettings> = {};
		if (typeof record.apiToken === 'string') out.apiToken = record.apiToken;
		if (typeof record.zoneId === 'string') out.zoneId = record.zoneId;
		if (typeof record.rootDomain === 'string') out.rootDomain = record.rootDomain;
		if (typeof record.targetHostname === 'string') out.targetHostname = record.targetHostname;
		if (typeof record.proxied === 'boolean') out.proxied = record.proxied;
		return out;
	}

	// HTTP + Cloudflare v4 wire format --------------------------------------

	private baseUrlFor(_settings: CloudflareDnsSettings): string {
		return CloudflareDnsPlugin.DEFAULT_API_BASE.replace(/\/$/, '');
	}

	private async findRecord(
		settings: CloudflareDnsSettings,
		name: string,
		type: DnsRecordType = 'CNAME'
	): Promise<DnsRecordSnapshot | null> {
		const url = new URL(`${this.baseUrlFor(settings)}/zones/${settings.zoneId}/dns_records`);
		url.searchParams.set('name', name);
		url.searchParams.set('type', type);
		const json = await this.request<{ result: DnsRecordSnapshot[] }>(settings, url.toString(), {
			method: 'GET'
		});
		return json.result[0] ?? null;
	}

	private async createRecord(
		settings: CloudflareDnsSettings,
		payload: {
			type: DnsRecordType;
			name: string;
			content: string;
			proxied: boolean;
			ttl: number;
		}
	): Promise<DnsRecordSnapshot> {
		const json = await this.request<{ result: DnsRecordSnapshot }>(
			settings,
			`${this.baseUrlFor(settings)}/zones/${settings.zoneId}/dns_records`,
			{ method: 'POST', body: JSON.stringify(payload) }
		);
		return json.result;
	}

	private async patchRecord(
		settings: CloudflareDnsSettings,
		id: string,
		payload: {
			type: DnsRecordType;
			name: string;
			content: string;
			proxied: boolean;
			ttl: number;
		}
	): Promise<DnsRecordSnapshot> {
		const json = await this.request<{ result: DnsRecordSnapshot }>(
			settings,
			`${this.baseUrlFor(settings)}/zones/${settings.zoneId}/dns_records/${id}`,
			{ method: 'PUT', body: JSON.stringify(payload) }
		);
		return json.result;
	}

	private async deleteRecord(settings: CloudflareDnsSettings, id: string): Promise<void> {
		await this.request(
			settings,
			`${this.baseUrlFor(settings)}/zones/${settings.zoneId}/dns_records/${id}`,
			{ method: 'DELETE' }
		);
	}

	private async request<T = unknown>(
		settings: CloudflareDnsSettings,
		url: string,
		init: RequestInit
	): Promise<T> {
		const response = await this.fetchImpl(url, {
			...init,
			headers: {
				Authorization: `Bearer ${settings.apiToken}`,
				'Content-Type': 'application/json',
				...(init.headers ?? {})
			}
		});
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		const bodyObj = body as { success?: boolean; errors?: unknown } | null;
		if (!response.ok || (bodyObj && bodyObj.success === false)) {
			const message = `Cloudflare API ${init.method ?? 'GET'} ${url} failed: ${response.status}`;
			const err = new CloudflareDnsPluginError(message, response.status, bodyObj?.errors ?? bodyObj ?? null);
			throw err;
		}
		return body as T;
	}

	private normalizeHost(host: string): string {
		const trimmed = (host ?? '').trim().toLowerCase();
		if (trimmed.length === 0 || trimmed.length > 253) {
			throw new Error(`Invalid host for Cloudflare DNS: ${host}`);
		}
		const labelRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
		for (const label of trimmed.split('.')) {
			if (!labelRe.test(label) || label.length > 63) {
				throw new Error(`Invalid host for Cloudflare DNS: ${host}`);
			}
		}
		return trimmed;
	}

	private log(message: string): void {
		this.context?.logger.log(message);
	}
}

/**
 * Error thrown when the Cloudflare API returns a non-2xx response or a
 * `success: false` payload.
 */
export class CloudflareDnsPluginError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly errors: unknown
	) {
		super(message);
		this.name = 'CloudflareDnsPluginError';
	}
}

export default CloudflareDnsPlugin;
