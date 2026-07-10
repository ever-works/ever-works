import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantCredentialSnapshot } from '@ever-works/plugin';
import { InngestDispatcherNotConfiguredError, InngestJobRuntimePlugin } from '../inngest-job-runtime.plugin.js';

describe('InngestJobRuntimePlugin (EW-742 P3.2 follow-up)', () => {
	let plugin: InngestJobRuntimePlugin;
	const origEnv = { ...process.env };

	beforeEach(() => {
		plugin = new InngestJobRuntimePlugin();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in origEnv)) delete process.env[key];
		}
		Object.assign(process.env, origEnv);
	});

	const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
		tenantId: '00000000-0000-0000-0000-00000000aaaa',
		providerId: 'inngest',
		credentialVersion: 1,
		credentials: { eventKey: 'tenant-acme-evk', signingKey: 'tenant-acme-sig' },
		...overrides
	});

	it('declares the canonical IPlugin metadata', () => {
		expect(plugin.id).toBe('job-runtime-inngest');
		expect(plugin.category).toBe('job-runtime');
		expect(plugin.runtimeId).toBe('inngest');
	});

	it('isEnabled true when both INNGEST keys are set', () => {
		process.env.INNGEST_EVENT_KEY = 'a';
		process.env.INNGEST_SIGNING_KEY = 'b';
		expect(plugin.isEnabled()).toBe(true);
	});

	it('isEnabled false when only one INNGEST key is set', () => {
		process.env.INNGEST_EVENT_KEY = 'a';
		delete process.env.INNGEST_SIGNING_KEY;
		expect(plugin.isEnabled()).toBe(false);
	});

	it('stub dispatchers throw InngestDispatcherNotConfiguredError', () => {
		const d = plugin.dispatchers as unknown as { dispatchX: () => unknown };
		expect(() => d.dispatchX()).toThrowError(InngestDispatcherNotConfiguredError);
	});

	it('lifecycle methods return safe defaults', async () => {
		await expect(plugin.cancel('r')).resolves.toBe(false);
		await expect(plugin.getRunStatus('r')).resolves.toBe('unknown');
		await expect(plugin.registerSchedules([])).resolves.toBeUndefined();
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	describe('bindToTenant', () => {
		it('exposes tenantEventKey + tenantSigningKey from snapshot.credentials', () => {
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantEventKey).toBe('tenant-acme-evk');
			expect(view.tenantSigningKey).toBe('tenant-acme-sig');
			expect(Object.isFrozen(view)).toBe(true);
		});

		it('null fields when credentials are absent', () => {
			const view = plugin.bindToTenant(snapshot({ credentials: {} }));
			expect(view.tenantEventKey).toBeNull();
			expect(view.tenantSigningKey).toBeNull();
		});

		it('memoises on (tenantId, credentialVersion)', () => {
			const a = plugin.bindToTenant(snapshot());
			const b = plugin.bindToTenant(snapshot());
			expect(b).toBe(a);
		});

		it('evicts older view on credentialVersion bump', () => {
			const v1 = plugin.bindToTenant(snapshot({ credentialVersion: 1 }));
			const v2 = plugin.bindToTenant(snapshot({ credentialVersion: 2 }));
			expect(v2).not.toBe(v1);
		});

		it('view.bindToTenant(self) returns self', () => {
			const view = plugin.bindToTenant(snapshot());
			expect(view.bindToTenant?.(snapshot())).toBe(view);
		});
	});
});
