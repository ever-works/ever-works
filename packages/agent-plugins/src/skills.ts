/**
 * Skills — spec 7.1, delegating the format itself to the Agent Skills
 * specification (<https://agentskills.io/specification>).
 *
 * Agent Plugins defines only *discovery*: "The fixed discovery location is
 * `skills/`. Each immediate child directory containing a path named exactly
 * `SKILL.md` that resolves to a regular file is treated as one skill.
 * Clients MUST NOT recursively search deeper descendants for additional
 * skills."
 *
 * Three details in that sentence do real work:
 *
 *  - **immediate child** — `skills/a/b/SKILL.md` is not a skill.
 *  - **named exactly `SKILL.md`** — checked against the directory listing,
 *    not by stat'ing the path. On Windows and macOS the filesystem is
 *    case-insensitive, so a stat of `SKILL.md` would happily match a file
 *    called `skill.md` and we would accept a package that a case-sensitive
 *    client rejects.
 *  - **resolves to a regular file** — a directory or a dangling symlink
 *    named `SKILL.md` is not a skill.
 *
 * Failure is per skill: "If a discovered skill does not conform to the Agent
 * Skills specification, the client MUST skip that skill and continue loading
 * other skills and component types."
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { finding, type Finding } from './findings';
import { isDirectory, isRegularFile, packageRelative, pathPresent, resolveWithinRoot } from './paths';

/** The fixed skills location, relative to the plugin root (spec 6.1). */
export const SKILLS_DIRNAME = 'skills';

/** The one file that makes a directory a skill (spec 7.1). */
export const SKILL_FILENAME = 'SKILL.md';

/** Optional per-skill directories defined by the Agent Skills specification. */
export const SKILL_SIDECAR_DIRNAMES = ['scripts', 'references', 'assets'] as const;

export type SkillSidecarKind = (typeof SKILL_SIDECAR_DIRNAMES)[number];

/**
 * Skill frontmatter as authored. Known fields are typed; unknown keys are
 * preserved verbatim, because the Agent Skills specification does not
 * reject them and a client further up the stack may care about them.
 */
export interface SkillFrontmatter {
	readonly name: string;
	readonly description: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly metadata?: Readonly<Record<string, string>>;
	/** Raw, space-separated, exactly as authored (spec field name `allowed-tools`). */
	readonly 'allowed-tools'?: string;
	readonly [key: string]: unknown;
}

/** One skill discovered inside a package. */
export interface DiscoveredSkill {
	/** Frontmatter `name`, which equals the directory name by construction. */
	readonly name: string;
	/** Absolute path of the skill directory. */
	readonly dir: string;
	/** Absolute path of its `SKILL.md`. */
	readonly skillMdPath: string;
	/** Package-relative POSIX path of the skill directory, for display. */
	readonly relDir: string;
	readonly frontmatter: SkillFrontmatter;
	/** Markdown body after the frontmatter block. */
	readonly body: string;
	/**
	 * `allowed-tools` split into tokens. Present only when the field was
	 * authored — an absent field and an empty one are different things to a
	 * consumer that gates tools on this list.
	 */
	readonly allowedTools?: readonly string[];
	/** Which of `scripts/`, `references/` and `assets/` this skill ships. */
	readonly sidecarDirs: readonly SkillSidecarKind[];
}

/** Result of scanning a package's `skills/` location. */
export interface SkillsDiscoveryResult {
	/**
	 * False when `skills/` is present but is not a directory, which makes
	 * the skills component type invalid while other component types keep
	 * loading (spec 6.2).
	 */
	readonly componentValid: boolean;
	/** True when `skills/` is simply absent, which spec 6.2 forbids treating as an error. */
	readonly componentAbsent: boolean;
	readonly skills: readonly DiscoveredSkill[];
	readonly findings: readonly Finding[];
}

/**
 * Skill name rule, from the Agent Skills specification: 1–64 characters of
 * lowercase `a-z`, `0-9` and `-`, never starting or ending with a hyphen and
 * never containing `--`.
 *
 * Note this is *narrower* than the plugin-name rule of spec 5.5, which also
 * permits `.`.
 */
export const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;

/** True when `value` satisfies every Agent Skills `name` constraint. */
export function isValidSkillName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 1 &&
		value.length <= SKILL_NAME_MAX_LENGTH &&
		SKILL_NAME_PATTERN.test(value)
	);
}

/**
 * Splits an `allowed-tools` value into tokens.
 *
 * The field is "a space-separated string of tools that are pre-approved to
 * run", and a token may itself contain punctuation — `Bash(git:*)` is one
 * token — so the only separator is whitespace.
 */
export function tokenizeAllowedTools(value: string): string[] {
	return value.split(/\s+/u).filter((token) => token.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Outcome of validating one skill's frontmatter. */
export type SkillFrontmatterResult =
	| {
			readonly ok: true;
			readonly frontmatter: SkillFrontmatter;
			readonly allowedTools?: readonly string[];
			readonly findings: readonly Finding[];
	  }
	| { readonly ok: false; readonly findings: readonly Finding[] };

/**
 * Validates skill frontmatter against the Agent Skills specification.
 *
 * `dirName` is required because one of the rules is relational: the
 * frontmatter `name` "must match the parent directory name". A mismatch is
 * not a warning — the name is how every client addresses the skill, so a
 * package where the two disagree is ambiguous and the skill is skipped.
 */
export function validateSkillFrontmatter(data: unknown, dirName: string): SkillFrontmatterResult {
	const at = `${SKILLS_DIRNAME}/${dirName}/${SKILL_FILENAME}`;
	const fail = (code: Parameters<typeof finding>[0], message: string, subject?: string): SkillFrontmatterResult => ({
		ok: false,
		findings: [finding(code, 'error', 'skill', message, subject === undefined ? { at } : { subject, at })]
	});

	if (!isPlainObject(data)) {
		return fail('skill.frontmatter-invalid', `Skill "${dirName}" has no usable YAML frontmatter mapping`);
	}

	const rawName = data['name'];
	if (rawName === undefined || rawName === null || rawName === '') {
		return fail('skill.name-missing', `Skill "${dirName}" is missing the required frontmatter "name"`, 'name');
	}
	if (!isValidSkillName(rawName)) {
		return fail(
			'skill.name-invalid',
			`Skill "${dirName}" has an invalid frontmatter "name": it must be 1-${SKILL_NAME_MAX_LENGTH} characters of lowercase letters, digits and "-", start and end alphanumeric, with no "--"`,
			'name'
		);
	}
	if (rawName !== dirName) {
		return fail(
			'skill.name-directory-mismatch',
			`Skill directory "${dirName}" declares frontmatter "name: ${rawName}"; the Agent Skills specification requires them to match`,
			'name'
		);
	}

	const rawDescription = data['description'];
	if (rawDescription === undefined || rawDescription === null || rawDescription === '') {
		return fail(
			'skill.description-missing',
			`Skill "${dirName}" is missing the required frontmatter "description"`,
			'description'
		);
	}
	if (typeof rawDescription !== 'string' || rawDescription.trim().length === 0) {
		return fail(
			'skill.description-invalid',
			`Skill "${dirName}" has a "description" that is not a non-empty string`,
			'description'
		);
	}
	if (rawDescription.length > SKILL_DESCRIPTION_MAX_LENGTH) {
		return fail(
			'skill.description-invalid',
			`Skill "${dirName}" has a "description" of ${rawDescription.length} characters; the maximum is ${SKILL_DESCRIPTION_MAX_LENGTH}`,
			'description'
		);
	}

	if ('license' in data && typeof data['license'] !== 'string') {
		return fail('skill.license-invalid', `Skill "${dirName}" has a "license" that is not a string`, 'license');
	}

	if ('compatibility' in data) {
		const compatibility = data['compatibility'];
		if (typeof compatibility !== 'string' || compatibility.length === 0) {
			return fail(
				'skill.compatibility-invalid',
				`Skill "${dirName}" has a "compatibility" that is not a non-empty string`,
				'compatibility'
			);
		}
		if (compatibility.length > SKILL_COMPATIBILITY_MAX_LENGTH) {
			return fail(
				'skill.compatibility-invalid',
				`Skill "${dirName}" has a "compatibility" of ${compatibility.length} characters; the maximum is ${SKILL_COMPATIBILITY_MAX_LENGTH}`,
				'compatibility'
			);
		}
	}

	if ('metadata' in data) {
		const metadata = data['metadata'];
		if (!isPlainObject(metadata)) {
			return fail(
				'skill.metadata-invalid',
				`Skill "${dirName}" has a "metadata" field that is not a mapping`,
				'metadata'
			);
		}
		for (const [key, value] of Object.entries(metadata)) {
			if (typeof value !== 'string') {
				return fail(
					'skill.metadata-invalid',
					`Skill "${dirName}" has a non-string "metadata" value for key "${key}"; the Agent Skills specification defines metadata as a map from string keys to string values`,
					'metadata'
				);
			}
		}
	}

	let allowedTools: readonly string[] | undefined;
	if ('allowed-tools' in data) {
		const raw = data['allowed-tools'];
		if (typeof raw !== 'string') {
			return fail(
				'skill.allowed-tools-invalid',
				`Skill "${dirName}" has an "allowed-tools" field that is not a space-separated string`,
				'allowed-tools'
			);
		}
		allowedTools = tokenizeAllowedTools(raw);
	}

	const frontmatter = data as unknown as SkillFrontmatter;
	return allowedTools === undefined
		? { ok: true, frontmatter, findings: [] }
		: { ok: true, frontmatter, allowedTools, findings: [] };
}

/** Outcome of parsing one `SKILL.md`. */
export type SkillMdResult =
	| {
			readonly ok: true;
			readonly frontmatter: SkillFrontmatter;
			readonly body: string;
			readonly allowedTools?: readonly string[];
	  }
	| { readonly ok: false; readonly findings: readonly Finding[] };

/** Parses a `SKILL.md` document: YAML frontmatter, then the Markdown body. */
export function parseSkillMd(content: string, dirName: string): SkillMdResult {
	const at = `${SKILLS_DIRNAME}/${dirName}/${SKILL_FILENAME}`;

	// Distinguish "no frontmatter block at all" from "frontmatter that fails
	// validation", so the operator gets an actionable message. A leading
	// byte-order mark is tolerated; gray-matter would otherwise miss the
	// opening delimiter.
	const normalised = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	if (!/^---\r?\n/.test(normalised)) {
		return {
			ok: false,
			findings: [
				finding(
					'skill.frontmatter-missing',
					'error',
					'skill',
					`Skill "${dirName}" has no YAML frontmatter block; ${SKILL_FILENAME} must open with "---"`,
					{ at }
				)
			]
		};
	}

	let parsed: { data: unknown; content: string };
	try {
		const result = matter(normalised);
		parsed = { data: result.data, content: result.content };
	} catch (error) {
		return {
			ok: false,
			findings: [
				finding(
					'skill.frontmatter-invalid',
					'error',
					'skill',
					`Skill "${dirName}" has frontmatter that is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
					{ at }
				)
			]
		};
	}

	const validated = validateSkillFrontmatter(parsed.data, dirName);
	if (!validated.ok) {
		return { ok: false, findings: validated.findings };
	}

	return validated.allowedTools === undefined
		? { ok: true, frontmatter: validated.frontmatter, body: parsed.content }
		: {
				ok: true,
				frontmatter: validated.frontmatter,
				body: parsed.content,
				allowedTools: validated.allowedTools
			};
}

/**
 * Discovers every skill in a package.
 *
 * Never throws for package-authoring problems: an absent `skills/` yields an
 * empty result, a `skills/` that is not a directory invalidates the
 * component type, and a broken skill is skipped. All three are reported.
 */
export async function discoverSkills(pluginRoot: string): Promise<SkillsDiscoveryResult> {
	const findings: Finding[] = [];
	const skillsDir = join(pluginRoot, SKILLS_DIRNAME);

	// Spec 6.2 — absence is measured WITHOUT following symlinks, so a dangling
	// `skills` link counts as present-but-broken rather than absent and falls
	// through to the not-a-directory check below.
	if (!(await pathPresent(skillsDir))) {
		// A missing fixed location MUST NOT be treated as an error.
		return { componentValid: true, componentAbsent: true, skills: [], findings };
	}

	// Spec 4.1 boundary 2 — a fixed component location that resolves outside
	// the root makes that component type invalid, not the whole package.
	const contained = await resolveWithinRoot(pluginRoot, SKILLS_DIRNAME);
	if (!contained.ok) {
		findings.push(
			finding(
				'package.path-escapes-root',
				'error',
				'skills-component',
				`"${SKILLS_DIRNAME}/" resolves outside the plugin root, so the skills component type is invalid`,
				{ at: SKILLS_DIRNAME }
			)
		);
		return { componentValid: false, componentAbsent: false, skills: [], findings };
	}

	if (!(await isDirectory(skillsDir))) {
		findings.push(
			finding(
				'skills.location-not-a-directory',
				'error',
				'skills-component',
				`"${SKILLS_DIRNAME}" exists but is not a directory, so the skills component type is invalid`,
				{ at: SKILLS_DIRNAME }
			)
		);
		return { componentValid: false, componentAbsent: false, skills: [], findings };
	}

	let entries: Dirent[];
	try {
		entries = await readdir(skillsDir, { withFileTypes: true });
	} catch (error) {
		findings.push(
			finding(
				'skills.location-unreadable',
				'error',
				'skills-component',
				`"${SKILLS_DIRNAME}/" could not be read: ${error instanceof Error ? error.message : String(error)}`,
				{ at: SKILLS_DIRNAME }
			)
		);
		return { componentValid: false, componentAbsent: false, skills: [], findings };
	}

	const skills: DiscoveredSkill[] = [];

	for (const entry of entries) {
		const dirName = entry.name;
		const skillDir = join(skillsDir, dirName);

		// Only immediate child *directories* are candidates. A symlinked
		// directory is allowed, provided it resolves inside the root.
		if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDirectory(skillDir)))) {
			continue;
		}

		// "a path named exactly SKILL.md" — read the listing so a
		// case-insensitive filesystem cannot smuggle `skill.md` past us.
		let childNames: string[];
		try {
			childNames = await readdir(skillDir);
		} catch (error) {
			findings.push(
				finding(
					'skill.unreadable',
					'error',
					'skill',
					`Skill directory "${dirName}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
					{ subject: dirName, at: `${SKILLS_DIRNAME}/${dirName}` }
				)
			);
			continue;
		}

		if (!childNames.includes(SKILL_FILENAME)) {
			findings.push(
				finding(
					'skills.directory-without-skill-md',
					'warning',
					'skills-component',
					`"${SKILLS_DIRNAME}/${dirName}" contains no ${SKILL_FILENAME} and is not a skill`,
					{ subject: dirName, at: `${SKILLS_DIRNAME}/${dirName}` }
				)
			);
			continue;
		}

		const skillMdPath = join(skillDir, SKILL_FILENAME);

		// Spec 4.1 boundary 3 — a SKILL.md resolving outside the root means
		// skip that skill.
		const skillMdContained = await resolveWithinRoot(pluginRoot, join(SKILLS_DIRNAME, dirName, SKILL_FILENAME));
		if (!skillMdContained.ok) {
			findings.push(
				finding(
					'package.path-escapes-root',
					'error',
					'skill',
					`Skill "${dirName}" has a ${SKILL_FILENAME} that resolves outside the plugin root and is skipped`,
					{ subject: dirName, at: `${SKILLS_DIRNAME}/${dirName}/${SKILL_FILENAME}` }
				)
			);
			continue;
		}

		if (!(await isRegularFile(skillMdPath))) {
			findings.push(
				finding(
					'skill.unreadable',
					'error',
					'skill',
					`Skill "${dirName}" has a ${SKILL_FILENAME} that does not resolve to a regular file and is skipped`,
					{ subject: dirName, at: `${SKILLS_DIRNAME}/${dirName}/${SKILL_FILENAME}` }
				)
			);
			continue;
		}

		let content: string;
		try {
			content = await readFile(skillMdPath, 'utf8');
		} catch (error) {
			findings.push(
				finding(
					'skill.unreadable',
					'error',
					'skill',
					`Skill "${dirName}" has an unreadable ${SKILL_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
					{ subject: dirName, at: `${SKILLS_DIRNAME}/${dirName}/${SKILL_FILENAME}` }
				)
			);
			continue;
		}

		const parsed = parseSkillMd(content, dirName);
		if (!parsed.ok) {
			findings.push(...parsed.findings);
			continue;
		}

		const sidecarDirs: SkillSidecarKind[] = [];
		for (const kind of SKILL_SIDECAR_DIRNAMES) {
			if (!childNames.includes(kind)) {
				continue;
			}
			const sidecar = await resolveWithinRoot(pluginRoot, join(SKILLS_DIRNAME, dirName, kind));
			if (sidecar.ok && (await isDirectory(join(skillDir, kind)))) {
				sidecarDirs.push(kind);
			}
		}

		const skill: DiscoveredSkill = {
			name: parsed.frontmatter.name,
			dir: skillDir,
			skillMdPath,
			relDir: packageRelative(pluginRoot, skillDir),
			frontmatter: parsed.frontmatter,
			body: parsed.body,
			sidecarDirs,
			...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools })
		};
		skills.push(skill);
	}

	// Stable, filesystem-independent ordering so catalogs and tests do not
	// depend on directory iteration order.
	skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	return { componentValid: true, componentAbsent: false, skills, findings };
}
