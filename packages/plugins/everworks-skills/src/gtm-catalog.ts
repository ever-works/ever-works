import { GTM_SKILLS, type GtmSkillDefinition, type GtmSkillIo } from '@ever-works/contracts';
import type { SkillCatalogEntry } from '@ever-works/plugin';

/**
 * First-party go-to-market Skills, projected into catalog entries.
 *
 * The Skill DEFINITIONS live in `@ever-works/contracts` because the agent
 * package references their slugs from the prebuilt Agent templates and the
 * two packages share no other runtime dependency. This module owns only the
 * projection into the plugin-facing `SkillCatalogEntry` shape — the same
 * shape `SKILL.md` files from the catalog repo are parsed into, so the
 * platform stores, renders, and installs them through exactly one path.
 *
 * These entries are a FLOOR, not a ceiling: `EverWorksSkillsPlugin` merges
 * them under whatever the catalog repo serves, so a published `SKILL.md`
 * with the same slug wins and the pack can be revised without a deploy.
 */

/** Render a Skill's declared IO contract as a Markdown table. */
function ioTable(heading: string, rows: readonly GtmSkillIo[]): string[] {
	if (rows.length === 0) {
		return [`## ${heading}`, '', '_None._'];
	}
	return [
		`## ${heading}`,
		'',
		'| Key | Meaning |',
		'| --- | --- |',
		...rows.map((row) => `| \`${row.key}\` | ${row.description} |`)
	];
}

/**
 * Build the canonical Markdown body for a Skill: the declared input/output
 * contract first (it is what makes the Skill deterministic about itself),
 * then the instruction text.
 */
export function buildGtmSkillBody(skill: GtmSkillDefinition): string {
	return [
		...ioTable('Inputs', skill.inputs),
		'',
		...ioTable('Outputs', skill.outputs),
		'',
		'## Instructions',
		'',
		skill.body
	].join('\n');
}

/** Project one Skill definition into a catalog entry. */
export function toSkillCatalogEntry(skill: GtmSkillDefinition): SkillCatalogEntry {
	return {
		slug: skill.slug,
		title: skill.title,
		description: skill.description,
		frontmatter: {
			name: skill.slug,
			description: skill.description,
			tags: [...skill.tags],
			allowedTools: [...skill.allowedTools],
			// Extra keys are preserved verbatim by the platform, so the
			// stage + IO contract survive install and stay inspectable.
			stage: skill.stage,
			inputs: skill.inputs.map((io) => io.key),
			outputs: skill.outputs.map((io) => io.key)
		},
		body: buildGtmSkillBody(skill),
		version: skill.version,
		tags: [...skill.tags]
	};
}

/** The whole first-party go-to-market pack as catalog entries. */
export const GTM_CATALOG_ENTRIES: SkillCatalogEntry[] = GTM_SKILLS.map(toSkillCatalogEntry);

/**
 * Union `entries` with the first-party pack, keeping `entries` on a slug
 * collision. Order is stable: served entries first, then the pack members
 * that were missing.
 */
export function mergeGtmCatalog(entries: SkillCatalogEntry[]): SkillCatalogEntry[] {
	const seen = new Set(entries.map((entry) => entry.slug));
	return [...entries, ...GTM_CATALOG_ENTRIES.filter((entry) => !seen.has(entry.slug))];
}
