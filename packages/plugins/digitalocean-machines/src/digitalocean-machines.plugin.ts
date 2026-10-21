import type {
	ConnectionValidationResult,
	IMachineProviderPlugin,
	IPlugin,
	JsonSchema,
	MachineProviderCreateInput,
	MachineProviderCreateResult,
	MachineProviderMachine,
	MachineProviderMachineState,
	MachineProviderOptions,
	MachineProviderUsage,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginSettings
} from '@ever-works/plugin';
import { MachineProviderError } from '@ever-works/plugin';

import { DigitalOceanApi } from './digitalocean-api.js';

/**
 * Cloud computers (FL-17, CONTRACTS R-15) — the first `machine-provider`
 * plugin: DigitalOcean droplets as Fleet computers, billed to the owner's
 * OWN DigitalOcean account.
 *
 * The platform hands it a bootstrap document it generated (`#cloud-config`
 * user data that installs the node runtime and enrols with a one-time token),
 * a throwaway public key and the tags; this plugin only talks to the provider:
 *
 *  - `listOptions` — `GET /v2/regions` + `GET /v2/sizes`, list prices in
 *    cents (`price_monthly` × 100, `price_hourly` × 100), `billsWhileOff: true`
 *    (DigitalOcean bills a powered-off droplet at its size);
 *  - `create` — uploads the throwaway public key (`POST /v2/account/keys`),
 *    `POST /v2/droplets` with `image: ubuntu-24-04-x64`, the user data, that
 *    key, the tags and monitoring on, then DELETES the key object again — so
 *    the provider never emails a root password and no key lingers on the
 *    account (spec FR-9);
 *  - `power` — `shutdown` (graceful) for off, `power_on` for on;
 *  - `destroy` — `DELETE /v2/droplets/{id}`, idempotent on 404;
 *  - `getMachine` / `listTagged` — `GET /v2/droplets/{id}` (404 = `gone`) and
 *    `GET /v2/droplets?tag_name=`;
 *  - `usage` — `GET /v2/customers/my/balance` (`month_to_date_usage`) when the
 *    token may read billing.
 *
 * The API token is an `x-secret`, user-scope setting: it reaches this plugin
 * in the per-call settings and goes nowhere but the `Authorization` header.
 */

/** The image every cloud computer boots (plan §6 OS matrix). */
export const DIGITALOCEAN_IMAGE = 'ubuntu-24-04-x64';
export const DIGITALOCEAN_IMAGE_LABEL = 'Ubuntu 24.04 LTS';

export const digitalOceanMachinesSettingsSchema: JsonSchema = {
	type: 'object',
	properties: {
		apiToken: {
			type: 'string',
			title: 'DigitalOcean API token',
			description:
				'A personal access token with read and write scope. Create one at https://cloud.digitalocean.com/account/api/tokens. Ever Works never shows it again after you save it.',
			'x-secret': true,
			'x-scope': 'user'
		},
		defaultRegion: {
			type: 'string',
			title: 'Default region',
			description: 'The region the New cloud computer dialog selects first (for example nyc3 or fra1).',
			'x-scope': 'user'
		}
	}
} as JsonSchema;

interface DoRegion {
	slug: string;
	name: string;
	available: boolean;
	sizes?: string[];
}

interface DoSize {
	slug: string;
	memory: number;
	vcpus: number;
	disk: number;
	price_monthly: number;
	price_hourly: number;
	regions: string[];
	available: boolean;
	description?: string;
}

interface DoDroplet {
	id: number | string;
	name?: string;
	status?: string;
	created_at?: string;
	tags?: string[];
	networks?: { v4?: Array<{ ip_address?: string; type?: string }> };
}

function tokenOf(settings?: PluginSettings): string {
	const token = settings && typeof settings.apiToken === 'string' ? settings.apiToken.trim() : '';
	if (!token) {
		throw new MachineProviderError('unauthorized', 'no DigitalOcean API token is saved; add one in the plugin settings');
	}
	return token;
}

/** `droplet.status` → the contract's machine state. */
export function dropletState(status: string | undefined): MachineProviderMachineState {
	switch (status) {
		case 'active':
			return 'running';
		case 'off':
			return 'off';
		case 'archive':
			return 'gone';
		default:
			return 'provisioning';
	}
}

function publicIpv4(droplet: DoDroplet): string | null {
	const entry = droplet.networks?.v4?.find((network) => network.type === 'public' && network.ip_address);
	return entry?.ip_address ?? null;
}

function toMachine(droplet: DoDroplet): MachineProviderMachine {
	return {
		machineRef: String(droplet.id),
		state: dropletState(droplet.status),
		ipv4: publicIpv4(droplet),
		tags: Array.isArray(droplet.tags) ? droplet.tags : [],
		name: droplet.name,
		createdAt: droplet.created_at ?? null
	};
}

function memoryLabel(mib: number): string {
	return mib >= 1024 ? `${Math.round((mib / 1024) * 10) / 10} GB` : `${mib} MB`;
}

/** A DigitalOcean tag: letters, digits, `_`, `-`, `:` — anything else becomes `-`. */
function safeTag(tag: string): string {
	return tag.replace(/[^A-Za-z0-9_:-]/g, '-').slice(0, 255);
}

export class DigitalOceanMachinesPlugin implements IPlugin, IMachineProviderPlugin {
	readonly id = 'digitalocean-machines';
	readonly name = 'DigitalOcean Machines';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'machine-provider';
	readonly providerName = 'DigitalOcean';
	readonly configurationMode = 'user-required' as const;
	readonly settingsSchema: JsonSchema = digitalOceanMachinesSettingsSchema;

	private context?: PluginContext;

	/** Test seams: a fetch implementation and a base URL (the fake API); production uses neither. */
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly baseUrl?: string
	) {}

	/**
	 * `machine-provider`; P3 adds `oauth` here when the operator registered an
	 * application (`DIGITALOCEAN_OAUTH_CLIENT_ID` / `_SECRET`), the deployment
	 * plugin's env-gated pattern.
	 */
	get capabilities(): readonly string[] {
		return ['machine-provider'];
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'DigitalOcean Machines is ready (each owner connects their own account)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Create cloud computers at DigitalOcean that join your Fleet, with the price shown before you create one',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'user-only',
			uiHints: {
				setupLink: {
					url: 'https://cloud.digitalocean.com/account/api/tokens',
					label: 'Create a DigitalOcean API token',
					showWhenEmpty: ['apiToken']
				},
				completionFields: ['apiToken']
			},
			readme: [
				'## Cloud computers at DigitalOcean',
				'',
				'Create a machine at DigitalOcean from **Fleet → Add computer → New cloud computer**. Ever Works shows the monthly and hourly list price before you create it; DigitalOcean bills your own account from the moment the machine exists until you destroy it — also while it is powered off.',
				'',
				'The machine installs the Ever Works node on first boot and enrols itself with a one-time token. Ever Works keeps no password or key for it.',
				'',
				'## Token',
				'',
				'Create a personal access token with **read and write** scope at https://cloud.digitalocean.com/account/api/tokens and save it here.'
			].join('\n'),
			homepage: 'https://www.digitalocean.com'
		};
	}

	isConfigured(settings?: PluginSettings): boolean {
		return Boolean(settings && typeof settings.apiToken === 'string' && settings.apiToken.trim());
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		try {
			const account = await this.account(settings as PluginSettings);
			return { success: true, message: `Connected to DigitalOcean as ${account}` };
		} catch (error) {
			return {
				success: false,
				message: error instanceof MachineProviderError ? error.hint : 'DigitalOcean could not be reached'
			};
		}
	}

	async listOptions(settings?: PluginSettings): Promise<MachineProviderOptions> {
		const api = this.api(settings);
		const [account, regionsRes, sizesRes] = await Promise.all([
			this.account(settings),
			api.request<{ regions?: DoRegion[] }>({ method: 'GET', path: '/v2/regions?per_page=200' }),
			api.request<{ sizes?: DoSize[] }>({ method: 'GET', path: '/v2/sizes?per_page=200' })
		]);
		const preferred = settings && typeof settings.defaultRegion === 'string' ? settings.defaultRegion : null;
		const regions = (regionsRes.data?.regions ?? [])
			.map((region) => ({ id: region.slug, label: region.name, available: region.available !== false }))
			.sort((a, b) => {
				// The owner's default region first, then available ones, then by name.
				if (preferred && (a.id === preferred) !== (b.id === preferred)) return a.id === preferred ? -1 : 1;
				if (a.available !== b.available) return a.available ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
		const sizes = (sizesRes.data?.sizes ?? [])
			.filter((size) => size.available !== false && Number(size.price_monthly) > 0)
			.map((size) => ({
				id: size.slug,
				label: `${size.vcpus} CPU · ${memoryLabel(size.memory)} · ${size.disk} GB`,
				vcpus: size.vcpus,
				memoryMiB: size.memory,
				diskGiB: size.disk,
				priceHourlyCents: Math.round(Number(size.price_hourly) * 100 * 1000) / 1000,
				priceMonthlyCents: Math.round(Number(size.price_monthly) * 100),
				regions: Array.isArray(size.regions) ? size.regions : [],
				available: size.available !== false
			}))
			.sort((a, b) => a.priceMonthlyCents - b.priceMonthlyCents);
		return {
			regions,
			sizes,
			software: [
				{ id: 'docker', default: true },
				{ id: 'node', default: true },
				{ id: 'claude-code', default: true },
				{ id: 'codex', default: true }
			],
			// DigitalOcean bills a powered-off droplet at its size.
			billsWhileOff: true,
			currency: 'USD',
			account: { label: account },
			imageLabel: DIGITALOCEAN_IMAGE_LABEL
		};
	}

	async create(input: MachineProviderCreateInput, settings?: PluginSettings): Promise<MachineProviderCreateResult> {
		const api = this.api(settings);
		let keyId: number | string | null = null;
		if (input.publicKey) {
			const key = await api.request<{ ssh_key?: { id?: number | string } }>({
				method: 'POST',
				path: '/v2/account/keys',
				body: { name: `ever-works-throwaway-${input.name}`, public_key: input.publicKey }
			});
			keyId = key.data?.ssh_key?.id ?? null;
		}
		try {
			const created = await api.request<{ droplet?: DoDroplet }>({
				method: 'POST',
				path: '/v2/droplets',
				body: {
					name: input.name,
					region: input.regionId,
					size: input.sizeId,
					image: DIGITALOCEAN_IMAGE,
					ssh_keys: keyId !== null ? [keyId] : [],
					user_data: input.bootstrapScript,
					tags: input.tags.map(safeTag),
					monitoring: true,
					ipv6: false
				}
			});
			const droplet = created.data?.droplet;
			if (!droplet || droplet.id === undefined || droplet.id === null) {
				throw new MachineProviderError('unavailable', 'DigitalOcean did not return the new droplet');
			}
			return {
				machineRef: String(droplet.id),
				state: dropletState(droplet.status),
				meta: { ipv4: publicIpv4(droplet), image: DIGITALOCEAN_IMAGE }
			};
		} finally {
			// The key object exists only for the create: the droplet already holds the
			// public half, and its private half was never kept by anyone.
			if (keyId !== null) {
				await api
					.request({ method: 'DELETE', path: `/v2/account/keys/${encodeURIComponent(String(keyId))}`, accept: [404] })
					.catch(() => undefined);
			}
		}
	}

	async power(machineRef: string, action: 'on' | 'off', settings?: PluginSettings): Promise<void> {
		const api = this.api(settings);
		await api.request({
			method: 'POST',
			path: `/v2/droplets/${encodeURIComponent(machineRef)}/actions`,
			// A graceful shutdown for off; DigitalOcean answers 422 when the droplet is
			// already in the asked-for state, which is the idempotent case.
			body: { type: action === 'off' ? 'shutdown' : 'power_on' },
			accept: [422]
		});
	}

	async destroy(machineRef: string, settings?: PluginSettings): Promise<void> {
		const api = this.api(settings);
		await api.request({ method: 'DELETE', path: `/v2/droplets/${encodeURIComponent(machineRef)}`, accept: [404] });
	}

	async getMachine(machineRef: string, settings?: PluginSettings): Promise<MachineProviderMachine> {
		const api = this.api(settings);
		const res = await api.request<{ droplet?: DoDroplet }>({
			method: 'GET',
			path: `/v2/droplets/${encodeURIComponent(machineRef)}`,
			accept: [404]
		});
		if (res.status === 404 || !res.data?.droplet) return { machineRef, state: 'gone' };
		return toMachine(res.data.droplet);
	}

	async listTagged(tag: string, settings?: PluginSettings): Promise<MachineProviderMachine[]> {
		const api = this.api(settings);
		const out: MachineProviderMachine[] = [];
		for (let page = 1; page <= 10; page += 1) {
			const res = await api.request<{ droplets?: DoDroplet[]; links?: { pages?: { next?: string } } }>({
				method: 'GET',
				path: `/v2/droplets?tag_name=${encodeURIComponent(safeTag(tag))}&per_page=200&page=${page}`
			});
			for (const droplet of res.data?.droplets ?? []) out.push(toMachine(droplet));
			if (!res.data?.links?.pages?.next) break;
		}
		return out;
	}

	async usage(_machineRefs: readonly string[], settings?: PluginSettings): Promise<MachineProviderUsage> {
		const api = this.api(settings);
		const res = await api.request<{ month_to_date_usage?: string }>({
			method: 'GET',
			path: '/v2/customers/my/balance',
			// A token without billing read answers 403: no provider figure, not an error.
			accept: [403]
		});
		const usd = Number(res.data?.month_to_date_usage);
		return res.status === 200 && Number.isFinite(usd)
			? { providerMonthToDateCents: Math.round(usd * 100), source: 'provider' }
			: { source: 'provider' };
	}

	/** The account label: the team's name, else the account's email. */
	private async account(settings?: PluginSettings): Promise<string> {
		const res = await this.api(settings).request<{ account?: { email?: string; team?: { name?: string } } }>({
			method: 'GET',
			path: '/v2/account'
		});
		const team = res.data?.account?.team?.name;
		const email = res.data?.account?.email;
		return (team && team.trim()) || (email && email.trim()) || 'DigitalOcean account';
	}

	private api(settings?: PluginSettings): DigitalOceanApi {
		return new DigitalOceanApi(tokenOf(settings), this.fetchImpl, this.baseUrl);
	}
}
