import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantCredentialSnapshot } from '@ever-works/plugin';
import { PgBossDispatcherNotConfiguredError, PgBossJobRuntimePlugin } from '../pgboss-job-runtime.plugin.js';

describe('PgBossJobRuntimePlugin (EW-742 P3.2 follow-up)', () => {
	let plugin: PgBossJobRuntimePlugin;
	const origEnv = { ...process.env };

	beforeEach(() => {
		plugin = new PgBossJobRuntimePlugin();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in origEnv)) delete process.env[key];
		}
		Object.assign(process.env, origEnv);
	});

	const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
		tenantId: '00000000-0000-0000-0000-00000000aaaa',
		providerId: 'pgboss',
		credentialVersion: 1,
		credentials: {
			schema: 'tenant_acme',
			connectionString: 'postgres://acme:pw@db:5432/jobs'
		},
		...overrides
	});

	it('declares the canonical IPlugin metadata', () => {
		expect(plugin.id).toBe('job-runtime-pgboss');
		expect(plugin.category).toBe('job-runtime');
		expect(plugin.runtimeId).toBe('pgboss');
	});

	it('isEnabled true when PGBOSS_CONNECTION_STRING is set', () => {
		process.env.PGBOSS_CONNECTION_STRING = 'postgres://localhost:5432/x';
		expect(plugin.isEnabled()).toBe(true);
	});

	it('stub dispatchers throw PgBossDispatcherNotConfiguredError', () => {
		const d = plugin.dispatchers as unknown as { dispatchAnything: () => unknown };
		expect(() => d.dispatchAnything()).toThrowError(PgBossDispatcherNotConfiguredError);
	});

	it('lifecycle methods return safe defaults', async () => {
		await expect(plugin.cancel('r')).resolves.toBe(false);
		await expect(plugin.getRunStatus('r')).resolves.toBe('unknown');
		await expect(plugin.registerSchedules([])).resolves.toBeUndefined();
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	describe('bindToTenant', () => {
		it('exposes tenantSchema + tenantConnectionString from snapshot.credentials', () => {
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantSchema).toBe('tenant_acme');
			expect(view.tenantConnectionString).toBe('postgres://acme:pw@db:5432/jobs');
			expect(Object.isFrozen(view)).toBe(true);
		});

		it('null fields when credentials are absent', () => {
			const view = plugin.bindToTenant(snapshot({ credentials: {} }));
			expect(view.tenantSchema).toBeNull();
			expect(view.tenantConnectionString).toBeNull();
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
