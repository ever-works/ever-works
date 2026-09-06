import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codes, fixture, scratchDir, subjectsFor, withCode } from './fixtures';
import {
	discoverSkills,
	isValidSkillName,
	parseSkillMd,
	tokenizeAllowedTools,
	validateSkillFrontmatter
} from '../skills';

const names = (skills: readonly { name: string }[]): string[] => skills.map((s) => s.name).sort();

describe('skills — discovery (spec 6.1, 6.2, 7.1)', () => {
	it('discovers every immediate child directory holding a SKILL.md', async () => {
		const result = await discoverSkills(fixture('valid-full'));
		expect(result.componentValid).toBe(true);
		expect(result.componentAbsent).toBe(false);
		expect(names(result.skills)).toEqual(['deploy', 'summarize']);
	});

	it('treats a missing skills/ location as no error at all (spec 6.2)', async () => {
		const result = await discoverSkills(fixture('valid-no-components'));
		expect(result.componentValid).toBe(true);
		expect(result.componentAbsent).toBe(true);
		expect(result.skills).toEqual([]);
		expect(result.findings).toEqual([]);
	});

	it('invalidates only the skills component when skills is present but not a directory', async () => {
		const result = await discoverSkills(fixture('skills-location-not-a-directory'));
		expect(result.componentValid).toBe(false);
		expect(result.componentAbsent).toBe(false);
		expect(codes(result.findings)).toEqual(['skills.location-not-a-directory']);
		expect(result.findings[0]?.scope).toBe('skills-component');
		expect(result.findings[0]?.severity).toBe('error');
	});

	it('never recurses into deeper descendants (spec 7.1)', async () => {
		const result = await discoverSkills(fixture('skills-not-recursive'));
		// skills/outer/inner/SKILL.md must not be found; skills/top/ must be.
		expect(names(result.skills)).toEqual(['top']);
		expect(subjectsFor(result.findings, 'skills.directory-without-skill-md')).toEqual(['outer']);
	});

	it('reports a child directory with no SKILL.md without failing anything', async () => {
		const result = await discoverSkills(fixture('skills-directory-without-skill-md'));
		expect(result.componentValid).toBe(true);
		expect(result.skills).toEqual([]);
		expect(withCode(result.findings, 'skills.directory-without-skill-md')[0]?.severity).toBe('warning');
	});

	it('skips one broken skill and keeps the rest (spec 7.1)', async () => {
		const result = await discoverSkills(fixture('skills-skip-one'));
		expect(names(result.skills)).toEqual(['good']);
		expect(codes(result.findings)).toEqual(['skill.name-directory-mismatch']);
	});

	it('returns skills in a stable order regardless of directory iteration', async () => {
		const first = await discoverSkills(fixture('valid-full'));
		const second = await discoverSkills(fixture('valid-full'));
		expect(first.skills.map((s) => s.name)).toEqual(second.skills.map((s) => s.name));
		expect(first.skills.map((s) => s.name)).toEqual(['deploy', 'summarize']);
	});

	it('requires the filename to be exactly SKILL.md, even on a case-insensitive filesystem', async () => {
		// The check reads the directory listing rather than stat'ing the
		// path. On Windows and macOS a stat of `SKILL.md` matches
		// `skill.md`, which would let us accept a package that a
		// case-sensitive client rejects.
		const root = await scratchDir();
		await mkdir(join(root, 'skills', 'lowercase'), { recursive: true });
		await writeFile(
			join(root, 'skills', 'lowercase', 'skill.md'),
			'---\nname: lowercase\ndescription: Wrong filename case.\n---\n\nBody.\n',
			'utf8'
		);
		const result = await discoverSkills(root);
		expect(result.skills).toEqual([]);
		expect(codes(result.findings)).toEqual(['skills.directory-without-skill-md']);
	});

	it('does not treat a SKILL.md that is a directory as a skill', async () => {
		const root = await scratchDir();
		await mkdir(join(root, 'skills', 'weird', 'SKILL.md'), { recursive: true });
		const result = await discoverSkills(root);
		expect(result.skills).toEqual([]);
		expect(codes(result.findings)).toEqual(['skill.unreadable']);
	});

	it('ignores a plain file sitting directly in skills/', async () => {
		const root = await scratchDir();
		await mkdir(join(root, 'skills'), { recursive: true });
		await writeFile(join(root, 'skills', 'notes.md'), '# not a skill\n', 'utf8');
		const result = await discoverSkills(root);
		expect(result.skills).toEqual([]);
		expect(result.findings).toEqual([]);
	});

	it('records which sidecar directories a skill ships', async () => {
		const result = await discoverSkills(fixture('valid-full'));
		const summarize = result.skills.find((s) => s.name === 'summarize');
		expect(summarize?.sidecarDirs).toEqual(['scripts', 'references', 'assets']);
		const deploy = result.skills.find((s) => s.name === 'deploy');
		expect(deploy?.sidecarDirs).toEqual([]);
	});

	it('exposes a package-relative POSIX path for display', async () => {
		const result = await discoverSkills(fixture('valid-full'));
		expect(result.skills.map((s) => s.relDir)).toEqual(['skills/deploy', 'skills/summarize']);
	});
});

describe('skills — frontmatter validation (Agent Skills specification)', () => {
	const at = (name: string) => `skills/${name}/SKILL.md`;

	it('parses a full frontmatter block and separates the body', () => {
		const result = parseSkillMd(
			'---\nname: full\ndescription: Does a thing. Use when a thing is needed.\nlicense: Apache-2.0\ncompatibility: Needs git\nallowed-tools: Bash(git:*) Read\nmetadata:\n  author: org\n---\n\n# Heading\n\nBody text.\n',
			'full'
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.frontmatter.name).toBe('full');
		expect(result.frontmatter.license).toBe('Apache-2.0');
		expect(result.frontmatter.metadata).toEqual({ author: 'org' });
		expect(result.allowedTools).toEqual(['Bash(git:*)', 'Read']);
		expect(result.body.trim()).toBe('# Heading\n\nBody text.');
	});

	it('reports a missing frontmatter block distinctly from an invalid one', () => {
		const result = parseSkillMd('# Just markdown\n\nNo frontmatter.\n', 'plain');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(codes(result.findings)).toEqual(['skill.frontmatter-missing']);
		expect(result.findings[0]?.at).toBe(at('plain'));
	});

	it('tolerates a leading byte-order mark before the frontmatter delimiter', () => {
		const result = parseSkillMd('﻿---\nname: bom\ndescription: Has a BOM.\n---\n\nBody.\n', 'bom');
		expect(result.ok).toBe(true);
	});

	it('reports invalid YAML as a frontmatter problem rather than throwing', () => {
		const result = parseSkillMd('---\nname: bad\ndescription: "unterminated\n---\n\nBody.\n', 'bad');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(codes(result.findings)).toEqual(['skill.frontmatter-invalid']);
	});

	it('requires the frontmatter name to equal the parent directory name', () => {
		const result = validateSkillFrontmatter({ name: 'other', description: 'Mismatched.' }, 'expected');
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['skill.name-directory-mismatch']);
	});

	it.each([
		['pdf-processing', true],
		['data-analysis', true],
		['a', true],
		['a1', true],
		['0-9', true],
		['a'.repeat(64), true],
		['PDF-Processing', false],
		['-pdf', false],
		['pdf-', false],
		['pdf--processing', false],
		['has_underscore', false],
		['has.dot', false],
		['has space', false],
		['', false],
		['a'.repeat(65), false]
	])('name %j is valid: %s', (name, valid) => {
		expect(isValidSkillName(name)).toBe(valid);
	});

	it('rejects a name containing a period, which the plugin rule allows but skills do not', () => {
		// The two name rules differ, and reusing the plugin rule here would
		// silently accept `acme.tools` as a skill name.
		expect(isValidSkillName('acme.tools')).toBe(false);
	});

	it('requires a name', () => {
		expect(codes(validateSkillFrontmatter({ description: 'No name.' }, 'x').findings)).toEqual([
			'skill.name-missing'
		]);
	});

	it('requires a non-empty description', () => {
		expect(codes(validateSkillFrontmatter({ name: 'x' }, 'x').findings)).toEqual(['skill.description-missing']);
		expect(codes(validateSkillFrontmatter({ name: 'x', description: '   ' }, 'x').findings)).toEqual([
			'skill.description-invalid'
		]);
	});

	it('caps the description at 1024 characters', () => {
		expect(validateSkillFrontmatter({ name: 'x', description: 'd'.repeat(1024) }, 'x').ok).toBe(true);
		const over = validateSkillFrontmatter({ name: 'x', description: 'd'.repeat(1025) }, 'x');
		expect(over.ok).toBe(false);
		expect(codes(over.findings)).toEqual(['skill.description-invalid']);
	});

	it('caps compatibility at 500 characters and requires a non-empty string when present', () => {
		expect(validateSkillFrontmatter({ name: 'x', description: 'd', compatibility: 'c'.repeat(500) }, 'x').ok).toBe(
			true
		);
		expect(validateSkillFrontmatter({ name: 'x', description: 'd', compatibility: 'c'.repeat(501) }, 'x').ok).toBe(
			false
		);
		expect(validateSkillFrontmatter({ name: 'x', description: 'd', compatibility: '' }, 'x').ok).toBe(false);
	});

	it('requires metadata to be a map of strings to strings', () => {
		expect(validateSkillFrontmatter({ name: 'x', description: 'd', metadata: { a: 'b' } }, 'x').ok).toBe(true);
		const numeric = validateSkillFrontmatter({ name: 'x', description: 'd', metadata: { a: 3 } }, 'x');
		expect(numeric.ok).toBe(false);
		expect(codes(numeric.findings)).toEqual(['skill.metadata-invalid']);
		expect(validateSkillFrontmatter({ name: 'x', description: 'd', metadata: [] }, 'x').ok).toBe(false);
	});

	it('requires allowed-tools to be a string, not a YAML list', () => {
		const asList = validateSkillFrontmatter({ name: 'x', description: 'd', 'allowed-tools': ['Read'] }, 'x');
		expect(asList.ok).toBe(false);
		expect(codes(asList.findings)).toEqual(['skill.allowed-tools-invalid']);
	});

	it('preserves unknown frontmatter keys instead of rejecting them', () => {
		const result = validateSkillFrontmatter(
			{ name: 'x', description: 'd', 'x-vendor-thing': 'keep me', nested: { a: 1 } },
			'x'
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.frontmatter['x-vendor-thing']).toBe('keep me');
		expect(result.frontmatter['nested']).toEqual({ a: 1 });
	});

	it('distinguishes an absent allowed-tools from an empty one', () => {
		const absent = validateSkillFrontmatter({ name: 'x', description: 'd' }, 'x');
		expect(absent.ok && absent.allowedTools).toBeUndefined();
		const empty = validateSkillFrontmatter({ name: 'x', description: 'd', 'allowed-tools': '' }, 'x');
		expect(empty.ok).toBe(true);
		expect(empty.ok && empty.allowedTools).toEqual([]);
	});

	it('rejects a YAML timestamp as metadata, which is a Date and not a mapping', () => {
		// A `Date` passes a naive "object and not an array" test while
		// `Object.entries` on it yields nothing, so a loop looking for
		// non-string values would wave an unquoted `2020-01-01` straight
		// through as a valid string-to-string map.
		const result = validateSkillFrontmatter({ name: 'x', description: 'd', metadata: new Date('2020-01-01') }, 'x');
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['skill.metadata-invalid']);
	});

	it('rejects a non-mapping frontmatter document', () => {
		expect(codes(validateSkillFrontmatter('just a string', 'x').findings)).toEqual(['skill.frontmatter-invalid']);
		expect(codes(validateSkillFrontmatter([], 'x').findings)).toEqual(['skill.frontmatter-invalid']);
	});
});

describe('skills — allowed-tools tokenizer', () => {
	it('splits on whitespace and keeps punctuation inside a token', () => {
		expect(tokenizeAllowedTools('Bash(git:*) Bash(jq:*) Read')).toEqual(['Bash(git:*)', 'Bash(jq:*)', 'Read']);
	});

	it('collapses runs of whitespace, including newlines and tabs', () => {
		expect(tokenizeAllowedTools('  Read \t\n  Write  ')).toEqual(['Read', 'Write']);
	});

	it('returns an empty list for an empty or whitespace-only value', () => {
		expect(tokenizeAllowedTools('')).toEqual([]);
		expect(tokenizeAllowedTools('   ')).toEqual([]);
	});
});

describe('skills — a package of broken skills loses only the broken ones', () => {
	it('keeps the one conforming skill and reports each failure with its own code', async () => {
		const result = await discoverSkills(fixture('skills-frontmatter-cases'));
		expect(names(result.skills)).toEqual(['survivor', 'unknown-keys']);
		expect(new Set(codes(result.findings))).toEqual(
			new Set([
				'skill.frontmatter-missing',
				'skill.frontmatter-invalid',
				'skill.name-missing',
				'skill.name-invalid',
				'skill.description-missing',
				'skill.description-invalid',
				'skill.compatibility-invalid',
				'skill.metadata-invalid',
				'skill.allowed-tools-invalid'
			])
		);
		// Nothing here may be fatal: a broken skill is a per-skill failure.
		expect(result.findings.every((f) => f.severity !== 'fatal')).toBe(true);
	});
});
