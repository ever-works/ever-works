import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantCredentialSnapshot } from '@ever-works/plugin';
import { BullMqDispatcherNotConfiguredError, BullMqJobRuntimePlugin } from '../bullmq-job-runtime.plugin.js';

describe('BullMqJobRuntimePlugin (EW-742 P3.2 follow-up)', () => {
	let plugin: BullMqJobRuntimePlugin;
	const origEnv = { ...process.env };

	beforeEach(() => {
		plugin = new BullMqJobRuntimePlugin();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in origEnv)) delete process.env[key];
		}
		Object.assign(process.env, origEnv);
	});

	const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
		tenantId: '00000000-0000-0000-0000-00000000aaaa',
		providerId: 'bullmq',
		credentialVersion: 1,
		credentials: { queuePrefix: 'tenant-acme', redisUrl: 'redis://tenant-acme:6379' },
		...overrides
	});

	it('declares the canonical IPlugin metadata', () => {
		expect(plugin.id).toBe('job-runtime-bullmq');
		expect(plugin.category).toBe('job-runtime');
		expect(plugin.runtimeId).toBe('bullmq');
	});

	it('isEnabled true when BULLMQ_REDIS_URL is set', () => {
		process.env.BULLMQ_REDIS_URL = 'redis://localhost:6379';
		expect(plugin.isEnabled()).toBe(true);
	});

	it('isEnabled false when BULLMQ_REDIS_URL is missing', () => {
		delete process.env.BULLMQ_REDIS_URL;
		expect(plugin.isEnabled()).toBe(false);
	});

	it('stub dispatchers throw BullMqDispatcherNotConfiguredError', () => {
		const d = plugin.dispatchers as unknown as { dispatchKbEmbedDocument: () => unknown };
		expect(() => d.dispatchKbEmbedDocument()).toThrowError(BullMqDispatcherNotConfiguredError);
	});

	it('lifecycle methods return safe defaults', async () => {
		await expect(plugin.cancel('r')).resolves.toBe(false);
		await expect(plugin.getRunStatus('r')).resolves.toBe('unknown');
		await expect(plugin.registerSchedules([])).resolves.toBeUndefined();
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	describe('bindToTenant', () => {
		it('exposes tenantQueuePrefix + tenantRedisUrl from snapshot.credentials', () => {
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantQueuePrefix).toBe('tenant-acme');
			expect(view.tenantRedisUrl).toBe('redis://tenant-acme:6379');
			expect(Object.isFrozen(view)).toBe(true);
		});

		it('null fields when credentials omit prefix/url', () => {
			const view = plugin.bindToTenant(snapshot({ credentials: {} }));
			expect(view.tenantQueuePrefix).toBeNull();
			expect(view.tenantRedisUrl).toBeNull();
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
