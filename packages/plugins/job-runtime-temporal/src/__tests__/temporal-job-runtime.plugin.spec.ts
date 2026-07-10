import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantCredentialSnapshot } from '@ever-works/plugin';
import { TemporalDispatcherNotConfiguredError, TemporalJobRuntimePlugin } from '../temporal-job-runtime.plugin.js';

describe('TemporalJobRuntimePlugin (EW-742 P3.2 follow-up)', () => {
	let plugin: TemporalJobRuntimePlugin;
	const origEnv = { ...process.env };

	beforeEach(() => {
		plugin = new TemporalJobRuntimePlugin();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in origEnv)) delete process.env[key];
		}
		Object.assign(process.env, origEnv);
	});

	const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
		tenantId: '00000000-0000-0000-0000-00000000aaaa',
		providerId: 'temporal',
		credentialVersion: 1,
		credentials: { namespace: 'tenant-acme' },
		...overrides
	});

	describe('manifest', () => {
		it('declares the canonical IPlugin metadata', () => {
			expect(plugin.id).toBe('job-runtime-temporal');
			expect(plugin.category).toBe('job-runtime');
			expect(plugin.runtimeId).toBe('temporal');
			expect(plugin.capabilities).toContain('job-runtime-bind-tenant');
		});
	});

	describe('isEnabled', () => {
		it('returns true when TEMPORAL_ADDRESS + TEMPORAL_NAMESPACE are set', () => {
			process.env.TEMPORAL_ADDRESS = 'temporal:7233';
			process.env.TEMPORAL_NAMESPACE = 'default';
			expect(plugin.isEnabled()).toBe(true);
		});
		it('returns false when address is missing', () => {
			delete process.env.TEMPORAL_ADDRESS;
			expect(plugin.isEnabled()).toBe(false);
		});
	});

	describe('stub dispatchers', () => {
		it('throws TemporalDispatcherNotConfiguredError on any dispatch* call', () => {
			const dispatcher = plugin.dispatchers as unknown as {
				dispatchKbEmbedDocument: (p: unknown) => unknown;
			};
			expect(() => dispatcher.dispatchKbEmbedDocument({})).toThrowError(TemporalDispatcherNotConfiguredError);
		});
	});

	describe('lifecycle no-ops', () => {
		it('cancel returns false', async () => {
			await expect(plugin.cancel('run-1')).resolves.toBe(false);
		});
		it('getRunStatus returns "unknown"', async () => {
			await expect(plugin.getRunStatus('run-1')).resolves.toBe('unknown');
		});
		it('registerSchedules is a no-op', async () => {
			await expect(plugin.registerSchedules([])).resolves.toBeUndefined();
		});
		it('startWorkerHost returns a no-op handle', async () => {
			const handle = await plugin.startWorkerHost({});
			await expect(handle.stop()).resolves.toBeUndefined();
		});
	});

	describe('bindToTenant', () => {
		it('returns a frozen per-tenant view with snapshot + namespace exposed', () => {
			const view = plugin.bindToTenant(snapshot());
			expect(view.runtimeId).toBe('temporal');
			expect(view.tenantSnapshot.tenantId).toBe('00000000-0000-0000-0000-00000000aaaa');
			expect(view.tenantNamespace).toBe('tenant-acme');
			expect(Object.isFrozen(view)).toBe(true);
		});

		it('returns null tenantNamespace when credentials.namespace is absent', () => {
			const view = plugin.bindToTenant(snapshot({ credentials: {} }));
			expect(view.tenantNamespace).toBeNull();
		});

		it('memoises on (tenantId, credentialVersion)', () => {
			const a = plugin.bindToTenant(snapshot());
			const b = plugin.bindToTenant(snapshot());
			expect(b).toBe(a);
		});

		it('evicts the older view when credentialVersion bumps', () => {
			const v1 = plugin.bindToTenant(snapshot({ credentialVersion: 1 }));
			const v2 = plugin.bindToTenant(snapshot({ credentialVersion: 2 }));
			expect(v2).not.toBe(v1);
			// v1 entry was evicted by the v2 cache-replace, so asking again
			// returns a fresh view.
			const v1Again = plugin.bindToTenant(snapshot({ credentialVersion: 1 }));
			expect(v1Again).not.toBe(v1);
		});

		it('view.bindToTenant(self) returns self', () => {
			const view = plugin.bindToTenant(snapshot());
			expect(view.bindToTenant?.(snapshot())).toBe(view);
		});

		it('view delegates lifecycle methods to base plugin', async () => {
			const view = plugin.bindToTenant(snapshot());
			await expect(view.cancel('run-x')).resolves.toBe(false);
			await expect(view.getRunStatus('run-x')).resolves.toBe('unknown');
		});
	});
});
