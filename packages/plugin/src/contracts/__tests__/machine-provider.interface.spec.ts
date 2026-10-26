import { describe, expect, it } from 'vitest';

import {
	isMachineProviderError,
	isMachineProviderPlugin,
	isMachineProviderSoftwareId,
	MACHINE_PROVIDER_CAPABILITY,
	MACHINE_PROVIDER_SOFTWARE_IDS,
	MachineProviderError,
	type IMachineProviderPlugin,
	type MachineProviderOptions
} from '../capabilities/machine-provider.interface.js';
import { ALL_PLUGIN_CAPABILITIES, isValidPluginCapability, PLUGIN_CAPABILITIES } from '../facade-capabilities.js';
import { isPluginCategory, PLUGIN_CATEGORIES } from '../plugin-manifest.types.js';

/**
 * FL-17 (CONTRACTS R-15) — the `machine-provider` capability and category.
 *
 *  1. The capability and the category are spelled exactly as CONTRACTS says
 *     and appended LAST (both lists are append-only surfaces).
 *  2. The guard is true only for a plugin that declares the capability.
 *  3. A fake provider compiles against the interface (the members the facade
 *     calls), so a member renamed here fails this file before it fails a plugin.
 */

const OPTIONS: MachineProviderOptions = {
	regions: [{ id: 'nyc3', label: 'New York 3', available: true }],
	sizes: [
		{
			id: 's-2vcpu-4gb',
			label: '2 CPU · 4 GB · 80 GB',
			vcpus: 2,
			memoryMiB: 4096,
			diskGiB: 80,
			priceHourlyCents: 3.571,
			priceMonthlyCents: 2400,
			regions: ['nyc3'],
			available: true
		}
	],
	software: [{ id: 'docker', default: true }],
	billsWhileOff: true,
	account: { label: 'acme' }
};

function fakeProvider(overrides: Partial<IMachineProviderPlugin> = {}): IMachineProviderPlugin {
	return {
		id: 'fake-machines',
		name: 'Fake machines',
		version: '1.0.0',
		capabilities: ['machine-provider'],
		providerName: 'Fake',
		isConfigured: () => true,
		listOptions: async () => OPTIONS,
		create: async () => ({ machineRef: '42', state: 'provisioning' }),
		power: async () => undefined,
		destroy: async () => undefined,
		getMachine: async (machineRef) => ({ machineRef, state: 'running' }),
		listTagged: async () => [],
		...overrides
	} as IMachineProviderPlugin;
}

describe('the machine-provider capability (FL-17)', () => {
	it('names the capability once, appended last to the table', () => {
		expect(MACHINE_PROVIDER_CAPABILITY).toBe('machine-provider');
		expect(PLUGIN_CAPABILITIES.MACHINE_PROVIDER).toBe(MACHINE_PROVIDER_CAPABILITY);
		const keys = Object.keys(PLUGIN_CAPABILITIES);
		expect(keys[keys.length - 1]).toBe('MACHINE_PROVIDER');
		expect(keys.indexOf('DOMAIN_EVENT_SUBSCRIBER')).toBe(keys.length - 2);
		expect(ALL_PLUGIN_CAPABILITIES.filter((value) => value === 'machine-provider')).toHaveLength(1);
		expect(isValidPluginCapability('machine-provider')).toBe(true);
		expect(isValidPluginCapability('machine-providers')).toBe(false);
	});

	it('appends the category last, once', () => {
		expect(PLUGIN_CATEGORIES[PLUGIN_CATEGORIES.length - 1]).toBe('machine-provider');
		expect(PLUGIN_CATEGORIES.indexOf('identity')).toBe(PLUGIN_CATEGORIES.length - 2);
		expect(PLUGIN_CATEGORIES.filter((entry) => entry === 'machine-provider')).toHaveLength(1);
		expect(isPluginCategory('machine-provider')).toBe(true);
	});

	it('guards on the declared capability only', () => {
		expect(isMachineProviderPlugin(fakeProvider())).toBe(true);
		expect(isMachineProviderPlugin(fakeProvider({ capabilities: ['deployment'] }))).toBe(false);
		expect(isMachineProviderPlugin(fakeProvider({ capabilities: [] }))).toBe(false);
	});

	it('lists the five software presets of spec FR-3', () => {
		expect([...MACHINE_PROVIDER_SOFTWARE_IDS]).toEqual(['docker', 'node', 'claude-code', 'codex', 'overlay-vpn']);
		expect(isMachineProviderSoftwareId('docker')).toBe(true);
		expect(isMachineProviderSoftwareId('ssh-server')).toBe(false);
	});

	it('recognises a provider refusal by shape as well as by class', () => {
		const error = new MachineProviderError('quota', 'droplet limit reached for this account', 422);
		expect(isMachineProviderError(error)).toBe(true);
		expect(error.hint).toBe('droplet limit reached for this account');
		// A copy that crossed a bundle boundary keeps its name and hint.
		expect(isMachineProviderError({ name: 'MachineProviderError', hint: 'x', code: 'quota' })).toBe(true);
		expect(isMachineProviderError(new Error('boom'))).toBe(false);
	});

	it('a fake provider answers through every member the facade calls', async () => {
		const provider = fakeProvider();
		expect((await provider.listOptions()).sizes[0].priceMonthlyCents).toBe(2400);
		expect(
			await provider.create({
				name: 'nyc-ops',
				regionId: 'nyc3',
				sizeId: 's-2vcpu-4gb',
				bootstrapScript: '#cloud-config\n',
				tags: ['ever-works', 'ever-works-node:n1']
			})
		).toEqual({ machineRef: '42', state: 'provisioning' });
		expect((await provider.getMachine('42')).state).toBe('running');
		await expect(provider.power('42', 'off')).resolves.toBeUndefined();
		await expect(provider.destroy('42')).resolves.toBeUndefined();
		expect(await provider.listTagged('ever-works')).toEqual([]);
	});
});
