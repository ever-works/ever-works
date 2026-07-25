import { describe, expect, it } from 'vitest';
import { GTM_SKILLS, GTM_SKILL_STAGES, listGtmSkillsForStage } from '@ever-works/contracts';
import { GTM_STAGE_IDS } from '../types.js';

/**
 * Stage-vocabulary parity pin.
 *
 * The first-party go-to-market Skills declare which stage they power, but
 * they live in `@ever-works/contracts` — BELOW this plugin in the dependency
 * graph — so the stage list is spelled out in both places rather than
 * imported. That duplication is only safe while something fails when the two
 * drift apart. This is that something.
 *
 * A drifted vocabulary is quiet and expensive: a Skill would declare a stage
 * this pipeline never runs, and it would simply never be reached.
 */
describe('go-to-market stage vocabulary parity', () => {
	it('the skill catalog and the pipeline agree on the stage list, in order', () => {
		expect([...GTM_SKILL_STAGES]).toEqual([...GTM_STAGE_IDS]);
	});

	it('every skill names a stage this pipeline actually runs', () => {
		const stages = new Set<string>(GTM_STAGE_IDS);
		for (const skill of GTM_SKILLS) {
			expect(stages.has(skill.stage), `skill "${skill.slug}" targets unknown stage "${skill.stage}"`).toBe(true);
		}
	});

	it('every executing stage has at least one skill behind it', () => {
		// `review` is deliberately empty — it is a human approval gate, not
		// model work, so a Skill there would imply self-approval.
		for (const stage of GTM_STAGE_IDS) {
			if (stage === 'review') continue;
			expect(listGtmSkillsForStage(stage).length, `stage "${stage}" has no skills`).toBeGreaterThan(0);
		}
	});
});
