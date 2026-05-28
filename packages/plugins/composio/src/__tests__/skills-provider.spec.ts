import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComposioPlugin } from '../composio.plugin.js';
import {
	buildSkillCatalogEntries,
	diffSkillCatalogVersions,
	filterSkillCatalog
} from '../skills-provider.js';
import type { SkillCatalogEntry } from '@ever-works/plugin';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function mockFetchAccounts(items: unknown[]): typeof fetch {
	return vi.fn().mockResolvedValue(jsonResponse({ items })) as unknown as typeof fetch;
}

describe('Composio skills-provider — capability surface', () => {
	it('declares the skills-provider capability', () => {
		const plugin = new ComposioPlugin();
		expect(plugin.capabilities).toContain('skills-provider');
		expect(plugin.providerName).toBe('Composio Integrations');
	});

	it('listEntries returns an empty result when settings are missing', async () => {
		const plugin = new ComposioPlugin();
		const result = await plugin.listEntries({ limit: 50, offset: 0 });
		expect(result).toEqual({ entries: [], total: 0 });
	});

	it('getEntry returns null when settings are missing', async () => {
		const plugin = new ComposioPlugin();
		expect(await plugin.getEntry('composio-gmail')).toBeNull();
	});
});

describe('buildSkillCatalogEntries', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns empty when apiKey or defaultUserId is missing', async () => {
		expect(await buildSkillCatalogEntries({ apiKey: '', defaultUserId: 'u' })).toEqual([]);
		expect(await buildSkillCatalogEntries({ apiKey: 'k', defaultUserId: '' })).toEqual([]);
	});

	it('emits one entry per unique ACTIVE toolkit, skipping INITIATED/EXPIRED', async () => {
		const fetchImpl = mockFetchAccounts([
			{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'GMAIL' } },
			{ id: 'ca_2', status: 'ACTIVE', toolkit: { slug: 'GMAIL' } }, // duplicate toolkit
			{ id: 'ca_3', status: 'ACTIVE', toolkit: { slug: 'GITHUB' } },
			{ id: 'ca_4', status: 'INITIATED', toolkit: { slug: 'SLACK' } },
			{ id: 'ca_5', status: 'EXPIRED', toolkit: { slug: 'NOTION' } }
		]);

		const entries = await buildSkillCatalogEntries({
			apiKey: 'k',
			baseUrl: 'https://composio.test/api/v3',
			defaultUserId: 'user-1',
			fetchImpl
		});

		expect(entries.map((e) => e.slug)).toEqual(['composio-github', 'composio-gmail']);
		const gmail = entries.find((e) => e.slug === 'composio-gmail');
		expect(gmail?.title).toBe('Composio: GMAIL');
		expect(gmail?.frontmatter.tags).toContain('composio');
		expect(gmail?.frontmatter.tags).toContain('gmail');
		expect(gmail?.body).toContain('GMAIL');
		expect(gmail?.body).toContain('user-1');
	});

	it('returns empty when the user has no ACTIVE connections', async () => {
		const fetchImpl = mockFetchAccounts([
			{ id: 'ca_1', status: 'INITIATED', toolkit: { slug: 'GMAIL' } }
		]);
		const entries = await buildSkillCatalogEntries({
			apiKey: 'k',
			defaultUserId: 'user-1',
			fetchImpl
		});
		expect(entries).toEqual([]);
	});
});

describe('filterSkillCatalog', () => {
	const entries: SkillCatalogEntry[] = [
		{
			slug: 'composio-gmail',
			title: 'Composio: GMAIL',
			description: 'Send email',
			frontmatter: { name: 'composio-gmail', description: 'Send email', tags: ['composio', 'gmail'] },
			body: 'body',
			version: '1.0.0',
			tags: ['composio', 'gmail', 'integration']
		},
		{
			slug: 'composio-github',
			title: 'Composio: GITHUB',
			description: 'Create issues',
			frontmatter: {
				name: 'composio-github',
				description: 'Create issues',
				tags: ['composio', 'github']
			},
			body: 'body',
			version: '1.0.0',
			tags: ['composio', 'github', 'integration']
		}
	];

	it('paginates', () => {
		const page1 = filterSkillCatalog(entries, { limit: 1, offset: 0 });
		const page2 = filterSkillCatalog(entries, { limit: 1, offset: 1 });
		expect(page1.entries).toHaveLength(1);
		expect(page1.total).toBe(2);
		expect(page2.entries[0].slug).not.toBe(page1.entries[0].slug);
	});

	it('filters by search across slug/title/description', () => {
		const result = filterSkillCatalog(entries, { limit: 50, offset: 0, search: 'github' });
		expect(result.entries.map((e) => e.slug)).toEqual(['composio-github']);
	});

	it('filters by tag (case-insensitive)', () => {
		const result = filterSkillCatalog(entries, { limit: 50, offset: 0, tags: ['GMAIL'] });
		expect(result.entries.map((e) => e.slug)).toEqual(['composio-gmail']);
	});
});

describe('diffSkillCatalogVersions', () => {
	it('flags entries whose installed version is older', () => {
		const entries: SkillCatalogEntry[] = [
			{
				slug: 'composio-gmail',
				title: 'Composio: GMAIL',
				description: 'd',
				frontmatter: { name: 'composio-gmail', description: 'd' },
				body: '',
				version: '1.0.0',
				tags: []
			}
		];
		const result = diffSkillCatalogVersions(entries, { 'composio-gmail': '0.9.0' });
		expect(result.updated).toEqual([
			{ slug: 'composio-gmail', oldVersion: '0.9.0', newVersion: '1.0.0' }
		]);
	});

	it('ignores entries the user does not have installed', () => {
		const entries: SkillCatalogEntry[] = [
			{
				slug: 'composio-gmail',
				title: 'g',
				description: 'd',
				frontmatter: { name: 'composio-gmail', description: 'd' },
				body: '',
				version: '1.0.0',
				tags: []
			}
		];
		const result = diffSkillCatalogVersions(entries, {});
		expect(result.updated).toEqual([]);
	});
});
