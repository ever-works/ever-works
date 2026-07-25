import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GTM_SKILLS } from '@ever-works/contracts';
import type { SkillCatalogEntry } from '@ever-works/plugin';
import { GTM_CATALOG_ENTRIES, buildGtmSkillBody, mergeGtmCatalog, toSkillCatalogEntry } from './gtm-catalog.js';
import { EverWorksSkillsPlugin } from './everworks-skills.plugin.js';

function stubEntry(slug: string, overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
	return {
		slug,
		title: `stub ${slug}`,
		description: 'stub',
		frontmatter: { name: slug, description: 'stub' },
		body: 'stub body',
		version: '9.9.9',
		tags: [],
		...overrides
	};
}

describe('GTM catalog projection', () => {
	it('projects every first-party skill into a catalog entry', () => {
		expect(GTM_CATALOG_ENTRIES).toHaveLength(GTM_SKILLS.length);
		expect(GTM_CATALOG_ENTRIES.map((e) => e.slug)).toEqual(GTM_SKILLS.map((s) => s.slug));
	});

	it('carries the declared IO contract into the entry body and frontmatter', () => {
		const skill = GTM_SKILLS.find((s) => s.slug === 'lead-scoring');
		expect(skill).toBeDefined();
		const entry = toSkillCatalogEntry(skill!);
		expect(entry.body).toContain('## Inputs');
		expect(entry.body).toContain('## Outputs');
		expect(entry.body).toContain('`score_weights`');
		expect(entry.frontmatter.inputs).toEqual(['contacts', 'score_weights']);
		expect(entry.frontmatter.outputs).toEqual(['scored_contacts']);
		expect(entry.frontmatter.stage).toBe('qualify');
	});

	it('keeps the instruction text intact under the contract tables', () => {
		for (const skill of GTM_SKILLS) {
			const body = buildGtmSkillBody(skill);
			expect(body).toContain('## Instructions');
			expect(body.endsWith(skill.body)).toBe(true);
		}
	});

	it('renders an empty IO list without emitting a broken table', () => {
		const entry = toSkillCatalogEntry({
			...GTM_SKILLS[0]!,
			slug: 'io-less',
			inputs: [],
			outputs: []
		});
		expect(entry.body).toContain('_None._');
		expect(entry.body).not.toContain('| --- |');
	});

	it('copies tags and allowedTools into the entry rather than sharing the frozen arrays', () => {
		const skill = GTM_SKILLS.find((s) => s.slug === 'contact-enrichment')!;
		const entry = toSkillCatalogEntry(skill);
		expect(entry.tags).toEqual([...skill.tags]);
		expect(entry.tags).not.toBe(skill.tags);
		expect(entry.frontmatter.allowedTools).toEqual([...skill.allowedTools]);
	});
});

describe('mergeGtmCatalog', () => {
	it('adds the whole pack to an empty catalog', () => {
		expect(mergeGtmCatalog([]).map((e) => e.slug)).toEqual(GTM_CATALOG_ENTRIES.map((e) => e.slug));
	});

	it('keeps served entries on a slug collision so the catalog repo can revise a skill', () => {
		const served = stubEntry('lead-scoring', { title: 'Published lead scoring' });
		const merged = mergeGtmCatalog([served]);
		const hit = merged.filter((e) => e.slug === 'lead-scoring');
		expect(hit).toHaveLength(1);
		expect(hit[0]!.title).toBe('Published lead scoring');
	});

	it('preserves served-first ordering and appends only the missing pack members', () => {
		const merged = mergeGtmCatalog([stubEntry('zzz-custom')]);
		expect(merged[0]!.slug).toBe('zzz-custom');
		expect(merged).toHaveLength(1 + GTM_CATALOG_ENTRIES.length);
	});
});

describe('EverWorksSkillsPlugin serves the first-party pack', () => {
	let plugin: EverWorksSkillsPlugin;

	beforeEach(async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network disabled in test');
			})
		);
		plugin = new EverWorksSkillsPlugin();
		await plugin.onLoad({
			logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
		} as never);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/**
	 * The whole reason the pack is a compiled-in floor: an activated Agent
	 * template whose suggested Skills resolve to nothing is a broken
	 * template, and that must not depend on the catalog repo being up.
	 */
	it('serves every go-to-market skill even when the catalog repo is unreachable', async () => {
		const result = await plugin.listEntries({ limit: 500, offset: 0 });
		const slugs = result.entries.map((e) => e.slug);
		for (const skill of GTM_SKILLS) {
			expect(slugs, `missing ${skill.slug}`).toContain(skill.slug);
		}
		expect(result.total).toBeGreaterThanOrEqual(GTM_SKILLS.length);
	});

	it('still serves the pre-existing builtin entries alongside the pack', async () => {
		const result = await plugin.listEntries({ limit: 500, offset: 0 });
		expect(result.entries.map((e) => e.slug)).toEqual(
			expect.arrayContaining(['cron-defaults', 'secret-handling', 'commit-message-style'])
		);
	});

	it('getEntry resolves a first-party skill by slug', async () => {
		const entry = await plugin.getEntry('outreach-personalization');
		expect(entry?.title).toBe('Outreach personalization');
		expect(entry?.body).toContain('## Inputs');
	});

	it('filters the pack by tag', async () => {
		const result = await plugin.listEntries({ limit: 500, offset: 0, tags: ['sales'] });
		expect(result.entries.length).toBeGreaterThan(0);
		for (const entry of result.entries) {
			expect(entry.tags).toContain('sales');
		}
	});

	it('finds a first-party skill via search', async () => {
		const result = await plugin.listEntries({ limit: 500, offset: 0, search: 'newsletter' });
		expect(result.entries.map((e) => e.slug)).toContain('newsletter-drafting');
	});
});
