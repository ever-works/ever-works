/**
 * An in-memory DigitalOcean v2 API for tests and the e2e flow: regions, sizes,
 * SSH keys, droplets (with tags and user data), droplet actions and the
 * balance. It records every request (with the Authorization header REDACTED,
 * so a test can assert the token never leaves the header) and answers like the
 * real API on the few endpoints the plugin uses.
 */

export interface FakeDroplet {
	id: number;
	name: string;
	region: string;
	size: string;
	status: 'new' | 'active' | 'off' | 'archive';
	tags: string[];
	user_data: string;
	ssh_keys: Array<number | string>;
	created_at: string;
}

export interface FakeRequest {
	method: string;
	path: string;
	body: unknown;
	authorized: boolean;
}

export interface FakeDigitalOceanApi {
	fetch: typeof fetch;
	droplets: Map<number, FakeDroplet>;
	keys: Map<number, { id: number; name: string; public_key: string }>;
	requests: FakeRequest[];
	/** Make the next droplet create answer 422 with this message. */
	refuseNextCreate(message: string): void;
	/** Simulate a droplet destroyed outside Ever Works. */
	forget(id: number): void;
}

export function createFakeDigitalOceanApi(token = 'do-test-token'): FakeDigitalOceanApi {
	const droplets = new Map<number, FakeDroplet>();
	const keys = new Map<number, { id: number; name: string; public_key: string }>();
	const requests: FakeRequest[] = [];
	let nextId = 1000;
	let refusal: string | null = null;

	const json = (status: number, body: unknown) =>
		new Response(body === null ? null : JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' }
		});

	const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? 'GET').toUpperCase();
		const headers = new Headers(init?.headers);
		const authorized = headers.get('authorization') === `Bearer ${token}`;
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
		requests.push({ method, path: `${url.pathname}${url.search}`, body, authorized });
		if (!authorized) return json(401, { id: 'unauthorized', message: 'Unable to authenticate you' });
		const path = url.pathname;

		if (method === 'GET' && path === '/v2/account') {
			return json(200, { account: { email: 'owner@example.com', team: { name: 'acme' } } });
		}
		if (method === 'GET' && path === '/v2/regions') {
			return json(200, {
				regions: [
					{ slug: 'nyc3', name: 'New York 3', available: true },
					{ slug: 'fra1', name: 'Frankfurt 1', available: true },
					{ slug: 'old1', name: 'Retired 1', available: false }
				]
			});
		}
		if (method === 'GET' && path === '/v2/sizes') {
			return json(200, {
				sizes: [
					{ slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80, price_monthly: 24, price_hourly: 0.03571, regions: ['nyc3', 'fra1'], available: true },
					{ slug: 's-1vcpu-2gb', memory: 2048, vcpus: 1, disk: 50, price_monthly: 12, price_hourly: 0.01786, regions: ['nyc3', 'fra1'], available: true },
					{ slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, price_monthly: 48, price_hourly: 0.07143, regions: ['nyc3'], available: true }
				]
			});
		}
		if (method === 'POST' && path === '/v2/account/keys') {
			const id = nextId++;
			keys.set(id, { id, name: String(body?.name ?? ''), public_key: String(body?.public_key ?? '') });
			return json(201, { ssh_key: { id, fingerprint: `fp:${id}` } });
		}
		const keyMatch = path.match(/^\/v2\/account\/keys\/(\d+)$/);
		if (method === 'DELETE' && keyMatch) {
			return keys.delete(Number(keyMatch[1])) ? json(204, null) : json(404, { id: 'not_found', message: 'not found' });
		}
		if (method === 'POST' && path === '/v2/droplets') {
			if (refusal) {
				const message = refusal;
				refusal = null;
				return json(422, { id: 'unprocessable_entity', message });
			}
			const id = nextId++;
			const droplet: FakeDroplet = {
				id,
				name: String(body?.name ?? ''),
				region: String(body?.region ?? ''),
				size: String(body?.size ?? ''),
				status: 'new',
				tags: Array.isArray(body?.tags) ? body.tags : [],
				user_data: String(body?.user_data ?? ''),
				ssh_keys: Array.isArray(body?.ssh_keys) ? body.ssh_keys : [],
				created_at: new Date().toISOString()
			};
			droplets.set(id, droplet);
			return json(202, { droplet: { ...droplet, user_data: undefined } });
		}
		if (method === 'GET' && path === '/v2/droplets') {
			const tag = url.searchParams.get('tag_name');
			const list = [...droplets.values()].filter((droplet) => !tag || droplet.tags.includes(tag));
			return json(200, { droplets: list.map((droplet) => ({ ...droplet, user_data: undefined })), links: {} });
		}
		const dropletMatch = path.match(/^\/v2\/droplets\/(\d+)$/);
		if (dropletMatch) {
			const id = Number(dropletMatch[1]);
			const droplet = droplets.get(id);
			if (method === 'GET') {
				return droplet
					? json(200, { droplet: { ...droplet, user_data: undefined, networks: { v4: [{ ip_address: '203.0.113.10', type: 'public' }] } } })
					: json(404, { id: 'not_found', message: 'The resource you were accessing could not be found.' });
			}
			if (method === 'DELETE') {
				return droplets.delete(id) ? json(204, null) : json(404, { id: 'not_found', message: 'not found' });
			}
		}
		const actionMatch = path.match(/^\/v2\/droplets\/(\d+)\/actions$/);
		if (method === 'POST' && actionMatch) {
			const droplet = droplets.get(Number(actionMatch[1]));
			if (!droplet) return json(404, { id: 'not_found', message: 'not found' });
			const type = String(body?.type ?? '');
			if ((type === 'shutdown' || type === 'power_off') && droplet.status === 'off') {
				return json(422, { id: 'unprocessable_entity', message: 'Droplet is already powered off' });
			}
			droplet.status = type === 'power_on' ? 'active' : 'off';
			return json(201, { action: { id: nextId++, status: 'in-progress', type } });
		}
		if (method === 'GET' && path === '/v2/customers/my/balance') {
			return json(200, { month_to_date_usage: '23.44' });
		}
		return json(404, { id: 'not_found', message: `no fake for ${method} ${path}` });
	}) as typeof fetch;

	return {
		fetch: fakeFetch,
		droplets,
		keys,
		requests,
		refuseNextCreate(message: string) {
			refusal = message;
		},
		forget(id: number) {
			droplets.delete(id);
		}
	};
}
