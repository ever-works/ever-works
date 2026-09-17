import { describe, expect, it } from 'vitest';

import {
	ACTION_CATEGORIES,
	ACTION_CATEGORY_CEILING,
	ACTION_CATEGORY_DEFAULT,
	ACTION_CATEGORY_I18N_KEY,
	ACTION_CATEGORY_RESTRICTIVENESS,
	DRAFTABLE_CATEGORIES,
	LADDERED_CATEGORIES,
	isActionCategory,
	isDraftableCategory,
	isLadderedCategory,
	moreRestrictiveCategory,
	type ActionCategory
} from '../action-category.types.js';
import { compareRung, TRUST_RUNG_ORDER } from '../trust-rung.types.js';

/**
 * The taxonomy is a CLOSED list: adding to it is a spec change, not a code
 * change. These assertions are what makes that true rather than aspirational —
 * a fourteenth category, a re-ordered table or a quietly raised ceiling all
 * fail here before they can reach a screen.
 */
describe('ACTION_CATEGORIES', () => {
	it('is exactly the thirteen kinds of work, in the order the screen renders them', () => {
		expect([...ACTION_CATEGORIES]).toEqual([
			'read.internal',
			'read.external',
			'write.internal',
			'write.destructive',
			'message.internal',
			'message.external',
			'publish.external',
			'spend.metered',
			'spend.commitment',
			'access.grant',
			'machine.run',
			'machine.admin',
			'agent.fanout'
		]);
	});

	it('has no duplicates', () => {
		expect(new Set(ACTION_CATEGORIES).size).toBe(ACTION_CATEGORIES.length);
	});

	it('is frozen, so a consumer cannot push a fourteenth at runtime', () => {
		expect(Object.isFrozen(ACTION_CATEGORIES)).toBe(true);
	});
});

describe('LADDERED_CATEGORIES', () => {
	it('is every category except read.internal', () => {
		expect(LADDERED_CATEGORIES).toHaveLength(12);
		expect(LADDERED_CATEGORIES).not.toContain('read.internal');
	});

	it('keeps the taxonomy order', () => {
		expect([...LADDERED_CATEGORIES]).toEqual(ACTION_CATEGORIES.filter((c) => c !== 'read.internal'));
	});

	it('leaves reading inside the workspace to connections and tool grants', () => {
		// FR-2. A second way to express what an Agent may read would be a second
		// thing to get wrong, and the two would drift.
		expect(isLadderedCategory('read.internal')).toBe(false);
		expect(ACTION_CATEGORY_CEILING as Record<string, unknown>).not.toHaveProperty('read.internal');
	});
});

describe('ACTION_CATEGORY_CEILING', () => {
	it('covers every laddered category and nothing else', () => {
		expect(Object.keys(ACTION_CATEGORY_CEILING).sort()).toEqual([...LADDERED_CATEGORIES].sort());
	});

	it('matches the shipped table', () => {
		expect(ACTION_CATEGORY_CEILING['read.external']).toBe('auto');
		expect(ACTION_CATEGORY_CEILING['write.internal']).toBe('auto');
		expect(ACTION_CATEGORY_CEILING['write.destructive']).toBe('ask');
		expect(ACTION_CATEGORY_CEILING['message.internal']).toBe('auto');
		expect(ACTION_CATEGORY_CEILING['message.external']).toBe('ask');
		expect(ACTION_CATEGORY_CEILING['publish.external']).toBe('ask');
		expect(ACTION_CATEGORY_CEILING['spend.metered']).toBe('auto');
		expect(ACTION_CATEGORY_CEILING['spend.commitment']).toBe('off');
		expect(ACTION_CATEGORY_CEILING['access.grant']).toBe('ask');
		expect(ACTION_CATEGORY_CEILING['machine.run']).toBe('auto');
		expect(ACTION_CATEGORY_CEILING['machine.admin']).toBe('ask');
		expect(ACTION_CATEGORY_CEILING['agent.fanout']).toBe('auto');
	});

	it('keeps money permanently off', () => {
		// FR-12. The platform exposes no mechanism by which an Agent buys,
		// refunds or moves money; a ceiling above `off` here would imply one.
		expect(ACTION_CATEGORY_CEILING['spend.commitment']).toBe('off');
	});

	it('names only known rungs', () => {
		for (const rung of Object.values(ACTION_CATEGORY_CEILING)) {
			expect(TRUST_RUNG_ORDER).toContain(rung);
		}
	});
});

describe('ACTION_CATEGORY_DEFAULT', () => {
	it('covers every laddered category', () => {
		expect(Object.keys(ACTION_CATEGORY_DEFAULT).sort()).toEqual([...LADDERED_CATEGORIES].sort());
	});

	it('never ships a default above its own ceiling', () => {
		for (const category of LADDERED_CATEGORIES) {
			expect(
				compareRung(ACTION_CATEGORY_DEFAULT[category], ACTION_CATEGORY_CEILING[category])
			).toBeLessThanOrEqual(0);
		}
	});

	it('starts a new workspace where the spec says it does', () => {
		expect(ACTION_CATEGORY_DEFAULT['read.external']).toBe('auto');
		expect(ACTION_CATEGORY_DEFAULT['write.internal']).toBe('auto');
		expect(ACTION_CATEGORY_DEFAULT['message.internal']).toBe('auto');
		expect(ACTION_CATEGORY_DEFAULT['spend.metered']).toBe('auto');
		expect(ACTION_CATEGORY_DEFAULT['message.external']).toBe('draft');
		expect(ACTION_CATEGORY_DEFAULT['machine.run']).toBe('ask');
		expect(ACTION_CATEGORY_DEFAULT['agent.fanout']).toBe('ask');
		expect(ACTION_CATEGORY_DEFAULT['spend.commitment']).toBe('off');
	});

	it('only ships Draft where Draft is offered', () => {
		// A default of `draft` on a category whose ladder skips Draft would be a
		// rung the owner can never return to.
		for (const category of LADDERED_CATEGORIES) {
			if (ACTION_CATEGORY_DEFAULT[category] === 'draft') {
				expect(DRAFTABLE_CATEGORIES).toContain(category);
			}
		}
	});
});

describe('DRAFTABLE_CATEGORIES', () => {
	it('is the six categories whose actions carry a reviewable artefact', () => {
		expect([...DRAFTABLE_CATEGORIES].sort()).toEqual(
			[
				'machine.admin',
				'machine.run',
				'message.external',
				'publish.external',
				'write.destructive',
				'write.internal'
			].sort()
		);
	});

	it('never offers Draft for a category with nothing to show', () => {
		for (const category of [
			'read.external',
			'message.internal',
			'spend.metered',
			'spend.commitment',
			'access.grant',
			'agent.fanout'
		] as ActionCategory[]) {
			expect(isDraftableCategory(category)).toBe(false);
		}
	});
});

describe('ACTION_CATEGORY_RESTRICTIVENESS', () => {
	it('ranks every category exactly once', () => {
		expect([...ACTION_CATEGORY_RESTRICTIVENESS].sort()).toEqual([...ACTION_CATEGORIES].sort());
	});

	it('puts money first and reading last', () => {
		expect(ACTION_CATEGORY_RESTRICTIVENESS[0]).toBe('spend.commitment');
		expect(ACTION_CATEGORY_RESTRICTIVENESS[ACTION_CATEGORY_RESTRICTIVENESS.length - 1]).toBe('read.internal');
	});
});

describe('moreRestrictiveCategory', () => {
	it('picks publishing over spending for a deploy', () => {
		// FR-6's worked example: deploying a site both publishes and spends.
		expect(moreRestrictiveCategory('publish.external', 'spend.metered')).toBe('publish.external');
		expect(moreRestrictiveCategory('spend.metered', 'publish.external')).toBe('publish.external');
	});

	it('is stable for equal inputs', () => {
		expect(moreRestrictiveCategory('machine.run', 'machine.run')).toBe('machine.run');
	});

	it('lets a known category win over one this build does not know', () => {
		expect(moreRestrictiveCategory('read.external', 'not.a.category' as ActionCategory)).toBe('read.external');
	});
});

describe('ACTION_CATEGORY_I18N_KEY', () => {
	it('covers every category', () => {
		expect(Object.keys(ACTION_CATEGORY_I18N_KEY).sort()).toEqual([...ACTION_CATEGORIES].sort());
	});

	it('never produces a leaf key containing a literal dot', () => {
		// next-intl throws at runtime on a dotted leaf name, and every category
		// id has a dot in it — which is exactly why this is a map, not a
		// derivation somewhere in the renderer.
		for (const key of Object.values(ACTION_CATEGORY_I18N_KEY)) {
			expect(key).not.toContain('.');
			expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
		}
	});

	it('gives every category a distinct key', () => {
		expect(new Set(Object.values(ACTION_CATEGORY_I18N_KEY)).size).toBe(ACTION_CATEGORIES.length);
	});
});

describe('isActionCategory', () => {
	it('accepts every shipped id', () => {
		for (const category of ACTION_CATEGORIES) expect(isActionCategory(category)).toBe(true);
	});

	it('refuses everything else, including values that stringify plausibly', () => {
		for (const value of [undefined, null, 123, true, ['read.external'], '', 'read'])
			expect(isActionCategory(value)).toBe(false);
	});
});
