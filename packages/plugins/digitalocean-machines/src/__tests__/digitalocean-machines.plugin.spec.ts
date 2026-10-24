import { describe, expect, it, vi } from 'vitest';
import { isMachineProviderError, isMachineProviderPlugin } from '@ever-works/plugin';

import { DigitalOceanMachinesPlugin, dropletState } from '../digitalocean-machines.plugin.js';
import { DigitalOceanApi, retryAfterMs, toProviderError } from '../digitalocean-api.js';
import { createFakeDigitalOceanApi } from '../testing/fake-digitalocean-api.js';

/**
 * FL-17 (T-09, plan §14) — the DigitalOcean machine provider against the
 * in-memory fake API: options in cents, create with tags + user data + the
 * throwaway key (deleted again), destroy idempotent, power, gone on 404, and
 * the token kept out of every error.
 */

const TOKEN = 'do-test-token';
const settings = { apiToken: TOKEN };

function plugin() {
	const fake = createFakeDigitalOceanApi(TOKEN);
	return { fake, provider: new DigitalOceanMachinesPlugin(fake.fetch, 'https://fake.digitalocean.test') };
}

describe('DigitalOceanMachinesPlugin (FL-17)', () => {
	it('is a machine provider and is configured only with a token', () => {
		const { provider } = plugin();
		expect(isMachineProviderPlugin(provider)).toBe(true);
		expect(provider.category).toBe('machine-provider');
		expect(provider.isConfigured({ apiToken: TOKEN })).toBe(true);
		expect(provider.isConfigured({ apiToken: '  ' })).toBe(false);
		expect(provider.isConfigured({})).toBe(false);
		// OAuth arrives in P3, env-gated.
		expect(provider.capabilities).toEqual(['machine-provider']);
	});

	it('maps regions and sizes to cents, cheapest first, available regions first', async () => {
		const { provider } = plugin();
		const options = await provider.listOptions(settings);
		expect(options.account.label).toBe('acme');
		expect(options.billsWhileOff).toBe(true);
		expect(options.regions.map((region) => region.id)).toEqual(['fra1', 'nyc3', 'old1']);
		expect(options.sizes.map((size) => size.id)).toEqual(['s-1vcpu-2gb', 's-2vcpu-4gb', 's-4vcpu-8gb']);
		const mid = options.sizes[1];
		expect(mid.priceMonthlyCents).toBe(2400);
		expect(mid.priceHourlyCents).toBeCloseTo(3.571, 3);
		expect(mid.label).toBe('2 CPU · 4 GB · 80 GB');
	});

	it('puts the default region first', async () => {
		const { provider } = plugin();
		const options = await provider.listOptions({ ...settings, defaultRegion: 'nyc3' });
		expect(options.regions[0].id).toBe('nyc3');
	});

	it('creates with the user data, the tags and the throwaway key, then deletes the key', async () => {
		const { fake, provider } = plugin();
		const result = await provider.create(
			{
				name: 'nyc-ops',
				regionId: 'nyc3',
				sizeId: 's-2vcpu-4gb',
				bootstrapScript: '#cloud-config\nruncmd: []\n',
				publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ever-works-throwaway',
				tags: ['ever-works', 'ever-works-node:0f8fad5b-d9cb-469f-a165-70867728950e']
			},
			settings
		);
		const droplet = fake.droplets.get(Number(result.machineRef));
		expect(droplet?.user_data).toBe('#cloud-config\nruncmd: []\n');
		expect(droplet?.tags).toEqual(['ever-works', 'ever-works-node:0f8fad5b-d9cb-469f-a165-70867728950e']);
		expect(droplet?.ssh_keys).toHaveLength(1);
		// The key object existed only for the create.
		expect(fake.keys.size).toBe(0);
		expect(result.state).toBe('provisioning');
		// The token travelled only in the header.
		expect(fake.requests.every((request) => request.authorized)).toBe(true);
		expect(JSON.stringify(fake.requests)).not.toContain(TOKEN);
	});

	it('quotes the provider’s first line when it refuses the create, and still deletes the key', async () => {
		const { fake, provider } = plugin();
		fake.refuseNextCreate('You have reached your droplet limit');
		const error = await provider
			.create(
				{
					name: 'nyc-ops',
					regionId: 'nyc3',
					sizeId: 's-2vcpu-4gb',
					bootstrapScript: '#cloud-config\n',
					publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl x',
					tags: ['ever-works']
				},
				settings
			)
			.catch((caught: unknown) => caught);
		expect(isMachineProviderError(error)).toBe(true);
		expect((error as { code: string }).code).toBe('quota');
		expect((error as { hint: string }).hint).toBe('You have reached your droplet limit');
		expect(fake.keys.size).toBe(0);
	});

	it('powers off gracefully and treats an already-off droplet as done', async () => {
		const { fake, provider } = plugin();
		const { machineRef } = await provider.create(
			{ name: 'a1', regionId: 'nyc3', sizeId: 's-1vcpu-2gb', bootstrapScript: '#cloud-config\n', tags: [] },
			settings
		);
		await provider.power(machineRef, 'off', settings);
		const action = fake.requests.find((request) => request.path.endsWith('/actions'));
		expect(action?.body).toEqual({ type: 'shutdown' });
		await expect(provider.power(machineRef, 'off', settings)).resolves.toBeUndefined();
		await provider.power(machineRef, 'on', settings);
		expect((await provider.getMachine(machineRef, settings)).state).toBe('running');
	});

	it('destroys idempotently and reports a forgotten droplet as gone', async () => {
		const { fake, provider } = plugin();
		const { machineRef } = await provider.create(
			{ name: 'a2', regionId: 'nyc3', sizeId: 's-1vcpu-2gb', bootstrapScript: '#cloud-config\n', tags: ['ever-works'] },
			settings
		);
		expect((await provider.listTagged('ever-works', settings)).map((machine) => machine.machineRef)).toEqual([machineRef]);
		await provider.destroy(machineRef, settings);
		await expect(provider.destroy(machineRef, settings)).resolves.toBeUndefined();
		expect((await provider.getMachine(machineRef, settings)).state).toBe('gone');
		expect(fake.droplets.size).toBe(0);
	});

	it('reads the provider’s month-to-date figure', async () => {
		const { provider } = plugin();
		expect(await provider.usage([], settings)).toEqual({ providerMonthToDateCents: 2344, source: 'provider' });
	});

	it('refuses without a token and never puts the token in an error', async () => {
		const { provider } = plugin();
		await expect(provider.listOptions({})).rejects.toMatchObject({ code: 'unauthorized' });
		const wrong = await provider.listOptions({ apiToken: 'wrong-token-value' }).catch((caught: unknown) => caught);
		expect((wrong as { code: string }).code).toBe('unauthorized');
		expect(JSON.stringify({ message: (wrong as Error).message, hint: (wrong as { hint: string }).hint })).not.toContain(
			'wrong-token-value'
		);
	});

	it('validates a connection by reading the account', async () => {
		const { provider } = plugin();
		expect(await provider.validateConnection(settings)).toEqual({ success: true, message: 'Connected to DigitalOcean as acme' });
		expect((await provider.validateConnection({ apiToken: 'nope' })).success).toBe(false);
	});

	it('maps droplet statuses', () => {
		expect(dropletState('active')).toBe('running');
		expect(dropletState('off')).toBe('off');
		expect(dropletState('archive')).toBe('gone');
		expect(dropletState('new')).toBe('provisioning');
	});
});

describe('DigitalOceanApi', () => {
	it('retries a 429 after Retry-After, at most twice', async () => {
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			return calls < 3
				? new Response('{}', { status: 429, headers: { 'retry-after': '2' } })
				: new Response('{"ok":true}', { status: 200 });
		}) as unknown as typeof fetch;
		const sleep = vi.fn(async () => undefined);
		const api = new DigitalOceanApi(TOKEN, fetchImpl, 'https://fake.test', sleep);
		const res = await api.request<{ ok: boolean }>({ method: 'GET', path: '/v2/account' });
		expect(res.data).toEqual({ ok: true });
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(2_000);
	});

	it('bounds Retry-After and maps statuses to typed errors', () => {
		expect(retryAfterMs(null)).toBe(1_000);
		expect(retryAfterMs('120')).toBe(10_000);
		expect(toProviderError(401, null).code).toBe('unauthorized');
		expect(toProviderError(422, { message: 'droplet limit reached for this account' }).code).toBe('quota');
		expect(toProviderError(500, { message: 'boom\nstack' }).hint).toBe('boom');
	});

	it('times out as a typed refusal', async () => {
		const fetchImpl = vi.fn(async () => {
			const error = new Error('aborted');
			error.name = 'AbortError';
			throw error;
		}) as unknown as typeof fetch;
		const api = new DigitalOceanApi(TOKEN, fetchImpl, 'https://fake.test');
		await expect(api.request({ method: 'GET', path: '/v2/account' })).rejects.toMatchObject({ code: 'unavailable' });
	});
});
