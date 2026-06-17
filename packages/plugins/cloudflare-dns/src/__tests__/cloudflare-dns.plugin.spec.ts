import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isDnsProvider, type IPlugin, type PluginContext } from '@ever-works/plugin';
import { CloudflareDnsPlugin, CloudflareDnsPluginError } from '../cloudflare-dns.plugin.js';
import { cloudflareDnsSettingsSchema } from '../settings.schema.js';

function createMockContext(settings: Record<string, unknown> = {}): PluginContext {
	return {
		pluginId: 'cloudflare-dns',
		logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		cache: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			has: vi.fn(),
			clear: vi.fn()
		} as unknown as PluginContext['cache'],
		http: {} as PluginContext['http'],
		env: {} as PluginContext['env'],
		envVars: {} as PluginContext['envVars'],
		services: {} as PluginContext['services'],
		getSettings: vi.fn().mockResolvedValue(settings),
		getResolvedSettings: vi.fn().mockResolvedValue(settings),
		updateSettings: vi.fn(),
		onEvent: vi.fn(),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn()
	} as unknown as PluginContext;
}

interface FakeRecord {
	id: string;
	type: 'CNAME' | 'A';
	name: string;
	content: string;
}

/**
 * In-memory Cloudflare v4 stub. Implements the four endpoints the plugin
 * calls: list records by `name`+`type`, POST create, PUT patch, DELETE.
 */
function createFakeCloudflare(initial: FakeRecord[] = []) {
	const store = new Map<string, FakeRecord>();
	let nextId = 1;
	for (const r of initial) store.set(r.id, r);

	const fetchImpl: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const method = init?.method ?? 'GET';
		if (method === 'GET' && url.pathname.endsWith('/dns_records')) {
			const name = url.searchParams.get('name');
			const type = url.searchParams.get('type');
			const result = [...store.values()].filter((r) => r.name === name && r.type === type);
			return new Response(JSON.stringify({ success: true, result }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (method === 'POST' && url.pathname.endsWith('/dns_records')) {
			const body = JSON.parse((init?.body as string) ?? '{}');
			const id = `rec_${nextId++}`;
			const record: FakeRecord = {
				id,
				type: body.type,
				name: body.name,
				content: body.content
			};
			store.set(id, record);
			return new Response(JSON.stringify({ success: true, result: record }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		const putMatch = method === 'PUT' && url.pathname.match(/\/dns_records\/([^/]+)$/);
		if (putMatch) {
			const id = putMatch[1];
			const body = JSON.parse((init?.body as string) ?? '{}');
			const updated: FakeRecord = {
				id,
				type: body.type,
				name: body.name,
				content: body.content
			};
			store.set(id, updated);
			return new Response(JSON.stringify({ success: true, result: updated }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		const delMatch = method === 'DELETE' && url.pathname.match(/\/dns_records\/([^/]+)$/);
		if (delMatch) {
			store.delete(delMatch[1]);
			return new Response(JSON.stringify({ success: true, result: { id: delMatch[1] } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		return new Response(JSON.stringify({ success: false, errors: [{ code: 404, message: 'not found' }] }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}) as unknown as typeof fetch;

	return { fetchImpl, store };
}

const BASE_SETTINGS = {
	apiToken: 'cf-token-test',
	zoneId: 'zone-test',
	rootDomain: 'ever.works',
	targetHostname: 'works-lb.example.com',
	proxied: false
};

async function loadedPlugin(settings = BASE_SETTINGS, initialRecords: FakeRecord[] = []) {
	const { fetchImpl, store } = createFakeCloudflare(initialRecords);
	const plugin = new CloudflareDnsPlugin(fetchImpl);
	await plugin.onLoad(createMockContext(settings));
	return { plugin, store, fetchImpl };
}

describe('CloudflareDnsPlugin', () => {
	let envSnapshot: NodeJS.ProcessEnv;
	beforeEach(() => {
		envSnapshot = { ...process.env };
		// Clear env vars that the plugin reads as fallbacks so tests
		// exercising error paths see a clean slate.
		delete process.env.CLOUDFLARE_API_TOKEN;
		delete process.env.CLOUDFLARE_ZONE_ID;
		delete process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME;
		delete process.env.EVER_WORKS_DOMAIN;
	});
	afterEach(() => {
		process.env = envSnapshot;
	});

	it('exposes a settingsSchema with the EW-738 spec keys + meta annotations', () => {
		expect(cloudflareDnsSettingsSchema.type).toBe('object');
		const props = cloudflareDnsSettingsSchema.properties ?? {};
		expect(props.apiToken['x-secret']).toBe(true);
		expect(props.apiToken['x-envVar']).toBe('CLOUDFLARE_API_TOKEN');
		expect(props.apiToken['x-scope']).toBe('user');
		expect(props.zoneId['x-envVar']).toBe('CLOUDFLARE_ZONE_ID');
		expect(props.rootDomain.default).toBe('ever.works');
		expect(props.targetHostname['x-adminOnly']).toBe(true);
		expect(props.proxied.default).toBe(true);
	});

	it('satisfies the EW-735 isDnsProvider type guard', async () => {
		const { plugin } = await loadedPlugin();
		// The function only requires `capabilities` + `id`; cast through
		// `IPlugin` to demonstrate the guard narrows correctly.
		const asPlugin = plugin as unknown as IPlugin;
		expect(isDnsProvider(asPlugin)).toBe(true);
	});

	it('rootDomain() returns the resolved root domain', async () => {
		const { plugin } = await loadedPlugin();
		// ensure a settings resolution has happened so the sync getter
		// returns the configured value instead of the schema default.
		await plugin.recordExists('foo.ever.works');
		expect(plugin.rootDomain()).toBe('ever.works');
	});

	it('ensureRecord creates a brand-new CNAME', async () => {
		const { plugin, store } = await loadedPlugin();
		const created = await plugin.ensureRecord({
			host: 'ai-coding.ever.works',
			type: 'CNAME',
			target: 'works-lb.example.com'
		});
		expect(created.name).toBe('ai-coding.ever.works');
		expect(created.type).toBe('CNAME');
		expect(created.content).toBe('works-lb.example.com');
		expect([...store.values()]).toHaveLength(1);
	});

	it('ensureRecord patches a drifted CNAME in place', async () => {
		const initial: FakeRecord = {
			id: 'rec_existing',
			type: 'CNAME',
			name: 'drift.ever.works',
			content: 'old-target.example.com'
		};
		const { plugin, store } = await loadedPlugin(BASE_SETTINGS, [initial]);
		const after = await plugin.ensureRecord({
			host: 'drift.ever.works',
			type: 'CNAME',
			target: 'new-target.example.com'
		});
		expect(after.id).toBe('rec_existing');
		expect(after.content).toBe('new-target.example.com');
		expect(store.get('rec_existing')?.content).toBe('new-target.example.com');
		// no new records were appended
		expect([...store.values()]).toHaveLength(1);
	});

	it('removeRecord deletes an existing CNAME record', async () => {
		const initial: FakeRecord = {
			id: 'rec_delete_me',
			type: 'CNAME',
			name: 'gone.ever.works',
			content: 'works-lb.example.com'
		};
		const { plugin, store } = await loadedPlugin(BASE_SETTINGS, [initial]);
		await plugin.removeRecord({ host: 'gone.ever.works', type: 'CNAME' });
		expect(store.size).toBe(0);
	});

	it('removeRecord without an explicit type probes both CNAME and A', async () => {
		const aRecord: FakeRecord = {
			id: 'rec_a',
			type: 'A',
			name: 'apex.ever.works',
			content: '1.2.3.4'
		};
		const { plugin, store } = await loadedPlugin(BASE_SETTINGS, [aRecord]);
		await plugin.removeRecord({ host: 'apex.ever.works' });
		expect(store.size).toBe(0);
	});

	it('recordExists returns true when ANY record (CNAME or A) is present', async () => {
		const aRecord: FakeRecord = {
			id: 'rec_collision',
			type: 'A',
			name: 'taken.ever.works',
			content: '1.2.3.4'
		};
		const { plugin } = await loadedPlugin(BASE_SETTINGS, [aRecord]);
		expect(await plugin.recordExists('taken.ever.works')).toBe(true);
		expect(await plugin.recordExists('free.ever.works')).toBe(false);
	});

	it('throws CloudflareDnsPluginError on non-2xx Cloudflare responses', async () => {
		// Stub fetch that always returns 500 with success: false.
		const failingFetch: typeof fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ success: false, errors: [{ code: 99, message: 'boom' }] }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
		) as unknown as typeof fetch;
		const plugin = new CloudflareDnsPlugin(failingFetch);
		await plugin.onLoad(createMockContext(BASE_SETTINGS));
		await expect(plugin.recordExists('whatever.ever.works')).rejects.toBeInstanceOf(
			CloudflareDnsPluginError
		);
	});

	it('rejects invalid host names', async () => {
		const { plugin } = await loadedPlugin();
		await expect(
			plugin.ensureRecord({ host: 'BAD HOST!', type: 'CNAME', target: 'x.example.com' })
		).rejects.toThrow(/Invalid host/);
	});
});
