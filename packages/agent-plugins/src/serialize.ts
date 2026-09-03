/**
 * The producer side — emitting conformant packages.
 *
 * A loader that can only read is half a client. Exporting matters because
 * the round trip is the strongest conformance test available: emit a
 * package, feed it back through this library at full strictness, and the
 * result must be identical to what went in.
 *
 * The interesting work here is *name narrowing*. Ever Works skill slugs are
 * validated as `[a-z0-9-]{1,80}`, which is wider than the Agent Skills name
 * rule in three ways: it allows up to 80 characters rather than 64, a
 * leading or trailing hyphen, and consecutive hyphens. Those slugs are
 * perfectly legal internally and completely illegal in a package, so export
 * must refuse them rather than emit something a conformant client will
 * reject — and it should offer the operator a repaired name instead of just
 * saying no.
 */

import matter from 'gray-matter';
import { finding, type Finding } from './findings';
import { isValidPluginName, PLUGIN_NAME_MAX_LENGTH, type AgentPluginManifest } from './manifest';
import { isValidSkillName, SKILL_DESCRIPTION_MAX_LENGTH, SKILL_NAME_MAX_LENGTH, type SkillFrontmatter } from './skills';

import { pluginSchemaId, PUBLISHED_CONFORMANCE_VERSION, type SpecVersion } from './versions';

// `isValidSkillName` and `isValidPluginName` are type predicates over
// `unknown`, which is what makes them useful when validating parsed
// frontmatter. Applied to a value already typed `string`, though, the
// negative branch narrows to `never` and the repair code below becomes
// unreachable to the compiler. These wrappers return a plain boolean, so the
// argument keeps its type on both branches.
const satisfiesSkillNameRule = (value: string): boolean => isValidSkillName(value);
const satisfiesPluginNameRule = (value: string): boolean => isValidPluginName(value);

/**
 * Ever Works' reverse-domain extension namespace, from the domain
 * `ever.works` reversed (spec 8).
 *
 * All Ever Works-specific manifest data lives under
 * `extensions["works.ever"]`. Adding an unknown *top-level* field would be
 * tolerated by a reading client but is invalid to emit, so we never do it.
 */
export const EVER_WORKS_EXTENSION_NAMESPACE = 'works.ever';

/** Reads one extension namespace from a manifest, without validating its contents (spec 8.1). */
export function readExtension(
	manifest: AgentPluginManifest,
	namespace: string
): Readonly<Record<string, unknown>> | undefined {
	return manifest.extensions?.[namespace];
}

/** Outcome of narrowing an internal identifier to a specification-legal name. */
export type NameNarrowing =
	| { readonly ok: true; readonly name: string }
	| {
			readonly ok: false;
			readonly reason: string;
			/** A repaired name that satisfies the rule, when one can be derived. */
			readonly suggestion?: string;
			readonly finding: Finding;
	  };

/**
 * Derives a name that satisfies the target rule, or `undefined` when
 * nothing usable survives.
 *
 * The two rules differ in one character: a plugin name may contain periods
 * (spec 5.5), a skill name may not. Collapsing periods to hyphens for a
 * plugin would rename `acme.tools` to `acme-tools` — a different package —
 * so the permitted set is a parameter rather than a constant.
 */
function repairName(value: string, maxLength: number, allowPeriods: boolean): string | undefined {
	const separators = allowPeriods ? 'a-z0-9.-' : 'a-z0-9-';
	const trim = allowPeriods ? /^[-.]+|[-.]+$/gu : /^-+|-+$/gu;
	let repaired = value
		.toLowerCase()
		.replace(new RegExp(`[^${separators}]+`, 'gu'), '-')
		.replace(/-{2,}/gu, '-');
	if (allowPeriods) {
		repaired = repaired.replace(/\.{2,}/gu, '.');
	}
	repaired = repaired.replace(trim, '').slice(0, maxLength).replace(trim, '');
	return repaired.length > 0 ? repaired : undefined;
}

/**
 * Narrows an Ever Works skill slug to an Agent Skills name.
 *
 * The name becomes both the skill directory name and its frontmatter
 * `name`, and the two must agree, so there is exactly one chance to get it
 * right.
 */
export function toSpecSkillName(slug: string): NameNarrowing {
	if (satisfiesSkillNameRule(slug)) {
		return { ok: true, name: slug };
	}
	const suggestion = repairName(slug, SKILL_NAME_MAX_LENGTH, false);
	const reason =
		slug.length > SKILL_NAME_MAX_LENGTH
			? `it is ${slug.length} characters and the Agent Skills limit is ${SKILL_NAME_MAX_LENGTH}`
			: /^-|-$/u.test(slug)
				? 'it starts or ends with a hyphen, which the Agent Skills name rule forbids'
				: slug.includes('--')
					? 'it contains consecutive hyphens, which the Agent Skills name rule forbids'
					: 'it contains characters outside lowercase letters, digits and hyphens';
	return {
		ok: false,
		reason,
		...(suggestion === undefined ? {} : { suggestion }),
		finding: finding(
			'export.skill-name-unusable',
			'error',
			'skill',
			`Skill slug "${slug}" cannot be exported: ${reason}${suggestion ? `. Rename it to "${suggestion}" to export.` : ''}`,
			{ subject: slug }
		)
	};
}

/** Narrows a name to the plugin-name rule of spec 5.5, which also permits periods. */
export function toSpecPluginName(value: string): NameNarrowing {
	if (satisfiesPluginNameRule(value)) {
		return { ok: true, name: value };
	}
	const suggestion = repairName(value, PLUGIN_NAME_MAX_LENGTH, true);
	const reason =
		value.length > PLUGIN_NAME_MAX_LENGTH
			? `it is ${value.length} characters and the limit is ${PLUGIN_NAME_MAX_LENGTH}`
			: 'it does not satisfy the plugin name rule: lowercase letters, digits, "-" and ".", starting and ending alphanumeric, with no "--" or ".."';
	return {
		ok: false,
		reason,
		...(suggestion === undefined ? {} : { suggestion }),
		finding: finding(
			'export.plugin-name-unusable',
			'error',
			'package',
			`Package name "${value}" cannot be exported: ${reason}${suggestion ? `. Use "${suggestion}" instead.` : ''}`,
			{ subject: value }
		)
	};
}

/** What a caller supplies to emit a `plugin.json`. */
export interface SerializeManifestInput {
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly author?: { readonly name?: string; readonly email?: string; readonly url?: string };
	readonly homepage?: string;
	readonly repository?: string;
	readonly license?: string;
	readonly keywords?: readonly string[];
	/** Namespaced client data. Keys must be reverse-domain namespaces (spec 8). */
	readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Emits a `plugin.json`.
 *
 * Absent fields are omitted rather than written as `null`: the schema types
 * every metadata field as a string or array, so a `null` would make the
 * manifest fatally invalid for a reader.
 */
export function serializeManifest(
	input: SerializeManifestInput,
	options?: { readonly specVersion?: SpecVersion; readonly indent?: number }
): string {
	const specVersion = options?.specVersion ?? PUBLISHED_CONFORMANCE_VERSION;
	const narrowed = toSpecPluginName(input.name);
	if (!narrowed.ok) {
		throw new Error(narrowed.finding.message);
	}

	const manifest: Record<string, unknown> = {
		$schema: pluginSchemaId(specVersion),
		name: narrowed.name
	};
	const put = (key: string, value: unknown): void => {
		if (value !== undefined && value !== null) {
			manifest[key] = value;
		}
	};
	put('version', input.version);
	put('description', input.description);
	if (input.author) {
		const author: Record<string, string> = {};
		for (const key of ['name', 'email', 'url'] as const) {
			const value = input.author[key];
			if (typeof value === 'string' && value.length > 0) {
				author[key] = value;
			}
		}
		if (Object.keys(author).length > 0) {
			manifest['author'] = author;
		}
	}
	put('homepage', input.homepage);
	put('repository', input.repository);
	put('license', input.license);
	if (input.keywords && input.keywords.length > 0) {
		manifest['keywords'] = [...input.keywords];
	}
	if (input.extensions && Object.keys(input.extensions).length > 0) {
		manifest['extensions'] = input.extensions;
	}

	return `${JSON.stringify(manifest, null, options?.indent ?? 2)}\n`;
}

/** What a caller supplies to emit a `SKILL.md`. */
export interface SerializeSkillInput {
	/** Becomes both the directory name and the frontmatter `name`. */
	readonly name: string;
	readonly description: string;
	readonly body: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly metadata?: Readonly<Record<string, string>>;
	/** Serialised back to the specification's space-separated `allowed-tools` string. */
	readonly allowedTools?: readonly string[];
	/** Unknown frontmatter keys to preserve, written after the known ones. */
	readonly extraFrontmatter?: Readonly<Record<string, unknown>>;
}

/**
 * Emits a `SKILL.md` with YAML frontmatter followed by the Markdown body.
 *
 * Field order is fixed (`name`, `description`, then the optional fields, then
 * preserved unknown keys in sorted order) so a re-export of unchanged input
 * produces a byte-identical file and diffs stay readable.
 */
export function serializeSkillMd(input: SerializeSkillInput): string {
	const narrowed = toSpecSkillName(input.name);
	if (!narrowed.ok) {
		throw new Error(narrowed.finding.message);
	}
	if (input.description.trim().length === 0) {
		throw new Error(`Skill "${narrowed.name}" cannot be exported without a description`);
	}
	if (input.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
		throw new Error(
			`Skill "${narrowed.name}" has a description of ${input.description.length} characters; the Agent Skills limit is ${SKILL_DESCRIPTION_MAX_LENGTH}`
		);
	}

	const data: Record<string, unknown> = {
		name: narrowed.name,
		description: input.description
	};
	if (input.license !== undefined) {
		data['license'] = input.license;
	}
	if (input.compatibility !== undefined) {
		data['compatibility'] = input.compatibility;
	}
	if (input.allowedTools !== undefined && input.allowedTools.length > 0) {
		// The specification's wire form is one space-separated string, even
		// though every consumer works with tokens.
		data['allowed-tools'] = input.allowedTools.join(' ');
	}
	if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
		data['metadata'] = input.metadata;
	}
	for (const key of Object.keys(input.extraFrontmatter ?? {}).sort()) {
		if (!(key in data)) {
			data[key] = input.extraFrontmatter?.[key];
		}
	}

	const body = input.body.startsWith('\n') ? input.body.slice(1) : input.body;
	return matter.stringify(body.endsWith('\n') ? body : `${body}\n`, data);
}

/** Rebuilds serializer input from a parsed skill, for a round trip. */
export function skillToSerializeInput(frontmatter: SkillFrontmatter, body: string): SerializeSkillInput {
	const known = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (!known.has(key)) {
			extra[key] = value;
		}
	}
	const allowed = frontmatter['allowed-tools'];
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		body,
		...(frontmatter.license === undefined ? {} : { license: frontmatter.license }),
		...(frontmatter.compatibility === undefined ? {} : { compatibility: frontmatter.compatibility }),
		...(frontmatter.metadata === undefined ? {} : { metadata: frontmatter.metadata }),
		...(typeof allowed === 'string' && allowed.trim().length > 0
			? { allowedTools: allowed.split(/\s+/u).filter((token) => token.length > 0) }
			: {}),
		...(Object.keys(extra).length > 0 ? { extraFrontmatter: extra } : {})
	};
}
