import { describe, it, expect, beforeEach } from 'vitest';
import { EverWorksSkillsPlugin } from './everworks-skills.plugin.js';

describe('EverWorksSkillsPlugin (builtin fallback catalog)', () => {
	let plugin: EverWorksSkillsPlugin;

	beforeEach(async () => {
		plugin = new EverWorksSkillsPlugin();
		await plugin.onLoad({
			logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
		} as any);
	});

	it('exposes the skills-provider capability', () => {
		expect(plugin.capabilities).toContain('skills-provider');
		expect(plugin.id).toBe('everworks-skills');
	});

	it('listEntries returns the builtin catalog by default', async () => {
		const result = await plugin.listEntries({ limit: 50, offset: 0 });
		expect(result.total).toBeGreaterThanOrEqual(3);
		expect(result.entries.map((e) => e.slug)).toEqual(
			expect.arrayContaining(['cron-defaults', 'secret-handling', 'commit-message-style']),
		);
	});

	it('listEntries paginates correctly', async () => {
		const page1 = await plugin.listEntries({ limit: 2, offset: 0 });
		const page2 = await plugin.listEntries({ limit: 2, offset: 2 });
		expect(page1.entries).toHaveLength(2);
		expect(page2.entries[0].slug).not.toEqual(page1.entries[0].slug);
	});

	it('listEntries filters by search term', async () => {
		const result = await plugin.listEntries({ limit: 50, offset: 0, search: 'cron' });
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].slug).toBe('cron-defaults');
	});

	it('listEntries filters by tag (case-insensitive)', async () => {
		const result = await plugin.listEntries({ limit: 50, offset: 0, tags: ['SECURITY'] });
		expect(result.entries.map((e) => e.slug)).toEqual(['secret-handling']);
	});

	it('getEntry returns one entry by slug', async () => {
		const entry = await plugin.getEntry('cron-defaults');
		expect(entry?.slug).toBe('cron-defaults');
		expect(entry?.body).toContain('UTC');
	});

	it('getEntry returns null for unknown slug', async () => {
		const entry = await plugin.getEntry('does-not-exist');
		expect(entry).toBeNull();
	});

	it('checkForUpdates flags rows whose installed version mismatches the catalog', async () => {
		const result = await plugin.checkForUpdates({
			'cron-defaults': '0.9.0',
			'secret-handling': '1.0.0',
		});
		expect(result.updated).toEqual([
			{ slug: 'cron-defaults', oldVersion: '0.9.0', newVersion: '1.0.0' },
		]);
	});

	it('isAvailable returns true (no required credentials)', () => {
		expect(plugin.isAvailable()).toBe(true);
	});
});
