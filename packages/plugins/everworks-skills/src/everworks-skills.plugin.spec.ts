import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EverWorksSkillsPlugin } from './everworks-skills.plugin.js';

function textResponse(body: string, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => body
	} as Response;
}

describe('EverWorksSkillsPlugin (builtin fallback catalog)', () => {
	let plugin: EverWorksSkillsPlugin;

	beforeEach(async () => {
		// Force the builtin fallback path by making every live fetch fail.
		// This keeps the fallback assertions below deterministic regardless
		// of whether the test runner has network access.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network disabled in test');
			})
		);
		plugin = new EverWorksSkillsPlugin();
		await plugin.onLoad({
			logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
		} as any);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('exposes the skills-provider capability', () => {
		expect(plugin.capabilities).toContain('skills-provider');
		expect(plugin.id).toBe('everworks-skills');
	});

	it('listEntries returns the builtin catalog by default', async () => {
		const result = await plugin.listEntries({ limit: 50, offset: 0 });
		expect(result.total).toBeGreaterThanOrEqual(3);
		expect(result.entries.map((e) => e.slug)).toEqual(
			expect.arrayContaining(['cron-defaults', 'secret-handling', 'commit-message-style'])
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
			'secret-handling': '1.0.0'
		});
		expect(result.updated).toEqual([{ slug: 'cron-defaults', oldVersion: '0.9.0', newVersion: '1.0.0' }]);
	});

	it('isAvailable returns true (no required credentials)', () => {
		expect(plugin.isAvailable()).toBe(true);
	});

	it('falls back to the builtin catalog when the manifest is malformed', async () => {
		// 200 OK but not a skills array -> loader throws -> builtin fallback.
		vi.stubGlobal('fetch', vi.fn(async () => textResponse(JSON.stringify({ nope: true }))));
		const fresh = new EverWorksSkillsPlugin();
		await fresh.onLoad({
			logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
		} as any);
		const result = await fresh.listEntries({ limit: 50, offset: 0 });
		expect(result.entries.map((e) => e.slug)).toEqual(
			expect.arrayContaining(['cron-defaults', 'secret-handling', 'commit-message-style'])
		);
	});
});

describe('EverWorksSkillsPlugin (live ever-works/skills catalog)', () => {
	const MANIFEST = JSON.stringify({
		version: 1,
		skills: [
			{
				slug: 'skill-creator',
				name: 'Skill Creator',
				summary: 'Create and improve Agent Skills.',
				skillPath: 'skills/skill-creator/SKILL.md',
				tags: ['meta', 'authoring'],
				version: '2.1.0',
				license: 'Apache-2.0',
				sourceUrl: 'https://github.com/ever-works/skills/tree/main/skills/skill-creator'
			}
		]
	});

	const SKILL_MD = `---
name: skill-creator
description: Frontmatter-level description of the skill.
allowedTools: ["Read", "Write"]
---

# Skill Creator

A skill for creating new skills, defaulting cron to UTC.`;

	let plugin: EverWorksSkillsPlugin;

	beforeEach(async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				if (url.endsWith('/manifest.json')) return textResponse(MANIFEST);
				if (url.endsWith('/SKILL.md')) return textResponse(SKILL_MD);
				throw new Error(`unexpected url ${url}`);
			})
		);
		plugin = new EverWorksSkillsPlugin();
		await plugin.onLoad({
			logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
		} as any);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('maps a manifest row + SKILL.md frontmatter into a SkillCatalogEntry', async () => {
		const entry = await plugin.getEntry('skill-creator');
		expect(entry).not.toBeNull();
		expect(entry).toMatchObject({
			slug: 'skill-creator',
			// title prefers the curated manifest name.
			title: 'Skill Creator',
			// description prefers the curated manifest summary.
			description: 'Create and improve Agent Skills.',
			// version prefers the manifest row version.
			version: '2.1.0',
			// tags come from the curated manifest row.
			tags: ['meta', 'authoring'],
			sourceUrl: 'https://github.com/ever-works/skills/tree/main/skills/skill-creator'
		});
		// frontmatter is the parsed SKILL.md frontmatter (not the manifest).
		expect(entry?.frontmatter.name).toBe('skill-creator');
		expect(entry?.frontmatter.description).toBe('Frontmatter-level description of the skill.');
		expect(entry?.frontmatter.allowedTools).toEqual(['Read', 'Write']);
		// body is the markdown WITHOUT the frontmatter block.
		expect(entry?.body.startsWith('# Skill Creator')).toBe(true);
		expect(entry?.body).not.toContain('---');
	});

	it('lists the live catalog entries', async () => {
		const result = await plugin.listEntries({ limit: 50, offset: 0 });
		expect(result.total).toBe(1);
		expect(result.entries[0].slug).toBe('skill-creator');
	});
});
