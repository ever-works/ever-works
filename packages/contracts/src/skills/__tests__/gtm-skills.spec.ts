import { describe, expect, it } from 'vitest';
import {
	GTM_SKILLS,
	GTM_SKILL_SLUGS,
	GTM_SKILL_STAGES,
	getGtmSkill,
	isGtmSkillSlug,
	listGtmSkills,
	listGtmSkillsForStage
} from '../gtm-skills.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IO_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

describe('GTM_SKILLS catalog integrity', () => {
	it('ships the full go-to-market skill set', () => {
		expect(GTM_SKILLS.length).toBeGreaterThanOrEqual(16);
		expect(GTM_SKILL_SLUGS).toEqual(
			expect.arrayContaining([
				'lead-research',
				'competitor-watch',
				'news-signal-detection',
				'lead-scoring',
				'risk-filter',
				'outreach-personalization',
				'newsletter-drafting',
				'social-scheduling',
				'digest-compilation',
				'crm-sync-hygiene',
				'follow-up-cadence',
				'reply-detection',
				'contact-enrichment',
				'seo-audit',
				'campaign-reporting',
				'engagement-analysis'
			])
		);
	});

	it('slugs are unique and kebab-case', () => {
		expect(new Set(GTM_SKILL_SLUGS).size).toBe(GTM_SKILL_SLUGS.length);
		for (const slug of GTM_SKILL_SLUGS) {
			expect(slug).toMatch(SLUG_PATTERN);
		}
	});

	it('every skill carries a substantial description, title, and instruction body', () => {
		for (const skill of GTM_SKILLS) {
			expect(skill.title.trim().length).toBeGreaterThan(3);
			expect(skill.description.trim().length).toBeGreaterThan(40);
			expect(skill.body.trim().length).toBeGreaterThan(200);
			expect(skill.version).toMatch(SEMVER_PATTERN);
		}
	});

	it('every skill declares a stage from the go-to-market stage vocabulary', () => {
		for (const skill of GTM_SKILLS) {
			expect(GTM_SKILL_STAGES).toContain(skill.stage);
		}
	});

	/**
	 * The point of the Skill being "deterministic about its own contract":
	 * a Skill that declares no output has not said what it is responsible
	 * for producing, and the stage that runs it cannot hand anything on.
	 */
	it('every skill declares at least one input and one output, in the shared key vocabulary', () => {
		for (const skill of GTM_SKILLS) {
			expect(skill.inputs.length).toBeGreaterThan(0);
			expect(skill.outputs.length).toBeGreaterThan(0);
			for (const io of [...skill.inputs, ...skill.outputs]) {
				expect(io.key).toMatch(IO_KEY_PATTERN);
				expect(io.description.trim().length).toBeGreaterThan(10);
			}
		}
	});

	it('no skill declares a duplicate input or output key', () => {
		for (const skill of GTM_SKILLS) {
			const inputKeys = skill.inputs.map((io) => io.key);
			const outputKeys = skill.outputs.map((io) => io.key);
			expect(new Set(inputKeys).size).toBe(inputKeys.length);
			expect(new Set(outputKeys).size).toBe(outputKeys.length);
		}
	});

	it('tags always include the gtm family tag and stay kebab-case', () => {
		for (const skill of GTM_SKILLS) {
			expect(skill.tags).toContain('gtm');
			for (const tag of skill.tags) {
				expect(tag).toMatch(SLUG_PATTERN);
			}
		}
	});

	it('allowedTools is an advisory allowlist of known tool families', () => {
		const known = new Set(['search', 'content-extractor', 'connector', 'metrics']);
		for (const skill of GTM_SKILLS) {
			for (const tool of skill.allowedTools) {
				expect(known.has(tool)).toBe(true);
			}
		}
	});

	it('covers every stage that has outbound consequences with at least one skill', () => {
		for (const stage of ['research', 'qualify', 'draft', 'act', 'follow-up', 'enrich', 'measure'] as const) {
			expect(listGtmSkillsForStage(stage).length).toBeGreaterThan(0);
		}
	});

	it('leaves the review stage to the policy gate rather than a skill', () => {
		// `review` is a human approval gate governed by guardrails and the
		// policy matrix — modelling it as a Skill would imply the model can
		// approve its own output.
		expect(listGtmSkillsForStage('review')).toEqual([]);
	});
});

describe('GTM skill lookup helpers', () => {
	it('listGtmSkills returns the catalog in declared order', () => {
		expect(listGtmSkills()).toBe(GTM_SKILLS);
	});

	it('getGtmSkill resolves a known slug and tolerates casing and padding', () => {
		expect(getGtmSkill('lead-scoring')?.title).toBe('Lead scoring');
		expect(getGtmSkill('  LEAD-SCORING ')?.slug).toBe('lead-scoring');
	});

	it.each([
		['an unknown slug', 'not-a-skill'],
		['an empty string', ''],
		['undefined', undefined],
		['null', null],
		['a number', 42 as unknown as string]
	])('getGtmSkill degrades %s to undefined and never throws', (_label, input) => {
		expect(() => getGtmSkill(input as string | null | undefined)).not.toThrow();
		expect(getGtmSkill(input as string | null | undefined)).toBeUndefined();
	});

	it('isGtmSkillSlug mirrors getGtmSkill', () => {
		expect(isGtmSkillSlug('contact-enrichment')).toBe(true);
		expect(isGtmSkillSlug('contact-enrichment-v2')).toBe(false);
		expect(isGtmSkillSlug(null)).toBe(false);
	});

	it('listGtmSkillsForStage returns only that stage, in declared order', () => {
		const qualify = listGtmSkillsForStage('qualify');
		expect(qualify.map((skill) => skill.slug)).toEqual(['lead-scoring', 'risk-filter']);
		for (const skill of qualify) {
			expect(skill.stage).toBe('qualify');
		}
	});
});
