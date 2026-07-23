import { describe, it, expect, afterEach } from 'vitest';
import { PostgresDbPlugin } from './postgres-db.plugin';

/**
 * Deterministic unit coverage that does NOT require a live Postgres: identity,
 * the connection-string format guard (returns before any `pg` client is built),
 * the managed "Ever Works DB" env gate, and the manifest.
 */
describe('PostgresDbPlugin', () => {
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	it('exposes the expected identity + capabilities', () => {
		const p = new PostgresDbPlugin();
		expect(p.id).toBe('postgres-db');
		expect(p.category).toBe('database');
		expect(p.capabilities).toEqual(['database', 'datastore']);
		expect(p.isAvailable()).toBe(true);
	});

	it('rejects a non-postgres connection string without connecting', async () => {
		const p = new PostgresDbPlugin();
		const r = await p.testDatabaseConnection('mysql://u:pw@h/db');
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/postgres/i);
	});

	it('validateConnection requires a connection string in custom mode', async () => {
		const p = new PostgresDbPlugin();
		const r = await p.validateConnection({ mode: 'custom', customConnectionString: '   ' });
		expect(r.success).toBe(false);
	});

	it('offers the managed Ever Works DB only when its env is wired', () => {
		const p = new PostgresDbPlugin();
		delete process.env.DB_EVER_WORKS_SHARED_ENABLED;
		delete process.env.DB_EVER_WORKS_SHARED_ADMIN_URL;
		delete process.env.DB_EVER_WORKS_SHARED_HOST;
		expect(p.isEverWorksDbAvailable()).toBe(false);

		process.env.DB_EVER_WORKS_SHARED_ENABLED = 'true';
		process.env.DB_EVER_WORKS_SHARED_ADMIN_URL = 'postgresql://admin@h/postgres';
		process.env.DB_EVER_WORKS_SHARED_HOST = 'h';
		expect(p.isEverWorksDbAvailable()).toBe(true);
	});

	it('validateConnection succeeds in default mode when Ever Works DB is wired', async () => {
		const p = new PostgresDbPlugin();
		process.env.DB_EVER_WORKS_SHARED_ENABLED = 'true';
		process.env.DB_EVER_WORKS_SHARED_ADMIN_URL = 'postgresql://admin@h/postgres';
		process.env.DB_EVER_WORKS_SHARED_HOST = 'h';
		const r = await p.validateConnection({ mode: 'ever-works-db' });
		expect(r.success).toBe(true);
	});

	it('getManifest advertises the database category + onboarding hints', () => {
		const p = new PostgresDbPlugin();
		const m = p.getManifest();
		expect(m.id).toBe('postgres-db');
		expect(m.category).toBe('database');
		expect(m.uiHints?.includeInOnboarding).toBe(true);
		expect(m.defaultForCapabilities).toContain('datastore');
	});
});
