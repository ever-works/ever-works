import { describe, expect, it } from 'vitest';
import { GTM_SKILL_SLUGS, PLAYBOOK_MAX_STEPS, PLAYBOOK_MIN_STEPS, validatePlaybookEntry } from '@ever-works/contracts';
import { ALL_PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { BUILTIN_PLAYBOOKS } from './builtin-catalog.js';

describe('BUILTIN_PLAYBOOKS', () => {
	it('ships exactly the eight built-in playbooks', () => {
		expect(BUILTIN_PLAYBOOKS.map((entry) => entry.slug)).toEqual([
			'weekly-operations-report',
			'daily-decision-brief',
			'directory-freshness-sweep',
			'knowledge-gap-harvest',
			'release-checklist',
			'content-refresh-queue',
			'market-watch-brief',
			'inbox-triage-drafts'
		]);
	});

	it.each(BUILTIN_PLAYBOOKS.map((entry) => [entry.slug, entry] as const))('%s passes validation', (_slug, entry) => {
		expect(validatePlaybookEntry(entry)).toBeNull();
	});

	it('has at least five playbooks that need no connection at all', () => {
		const standalone = BUILTIN_PLAYBOOKS.filter((entry) => !entry.connections.some((need) => need.required));
		expect(standalone.length).toBeGreaterThanOrEqual(5);
	});

	it('names only capabilities the plugin system declares, never a provider id', () => {
		for (const entry of BUILTIN_PLAYBOOKS) {
			for (const need of entry.connections) {
				expect(ALL_PLUGIN_CAPABILITIES, `${entry.slug} → ${need.capability}`).toContain(need.capability);
			}
		}
	});

	it('references only Skills the first-party Skill catalogue ships', () => {
		const known = new Set(GTM_SKILL_SLUGS);
		for (const entry of BUILTIN_PLAYBOOKS) {
			expect(entry.provision.skillSlugs.length, entry.slug).toBeGreaterThan(0);
			for (const slug of entry.provision.skillSlugs) {
				expect(known.has(slug), `${entry.slug} references unknown skill "${slug}"`).toBe(true);
			}
		}
	});

	it('always adopts asking before acting', () => {
		for (const entry of BUILTIN_PLAYBOOKS) {
			expect(entry.provision.guardrailsAtAdoption.mode, entry.slug).toBe('require_approval');
		}
	});

	it('declares 2–8 numbered steps and marks at least one stopping point per playbook', () => {
		for (const entry of BUILTIN_PLAYBOOKS) {
			expect(entry.steps.length).toBeGreaterThanOrEqual(PLAYBOOK_MIN_STEPS);
			expect(entry.steps.length).toBeLessThanOrEqual(PLAYBOOK_MAX_STEPS);
			expect(entry.steps.map((step) => step.position)).toEqual(entry.steps.map((_, index) => index + 1));
			expect(entry.escalations.length, entry.slug).toBeGreaterThan(0);
		}
	});

	it('gives every schedule-triggered playbook a default cadence and local time', () => {
		for (const entry of BUILTIN_PLAYBOOKS.filter((e) => e.trigger.kind === 'schedule')) {
			expect(entry.trigger.cadence, entry.slug).toBeTruthy();
			expect(entry.trigger.defaultLocalTime, entry.slug).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
		}
	});

	it('has unique slugs and task template slugs', () => {
		const slugs = BUILTIN_PLAYBOOKS.map((entry) => entry.slug);
		const templateSlugs = BUILTIN_PLAYBOOKS.map((entry) => entry.provision.taskTemplate.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
		expect(new Set(templateSlugs).size).toBe(templateSlugs.length);
	});

	it('is frozen so no caller can mutate the shared catalogue', () => {
		expect(Object.isFrozen(BUILTIN_PLAYBOOKS)).toBe(true);
		expect(Object.isFrozen(BUILTIN_PLAYBOOKS[0])).toBe(true);
		expect(Object.isFrozen(BUILTIN_PLAYBOOKS[0]!.steps)).toBe(true);
	});
});
