import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, scratchDir } from './fixtures';
import { validateManifest } from '../manifest';
import { discoverSkills, parseSkillMd } from '../skills';
import {
	EVER_WORKS_EXTENSION_NAMESPACE,
	readExtension,
	serializeManifest,
	serializeSkillMd,
	skillToSerializeInput,
	toSpecPluginName,
	toSpecSkillName
} from '../serialize';
import { pluginSchemaId } from '../versions';

const ORIGINAL_SKILL = '---\nname: s\ndescription: d\n---\n\n# Heading\n\nText.\n';

describe('serialize — plugin.json emission', () => {
	it('emits a minimal manifest that validates at full strictness', () => {
		const text = serializeManifest({ name: 'my-plugin' });
		const parsed = validateManifest(JSON.parse(text));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.manifest.$schema).toBe(pluginSchemaId('1.0.0'));
		expect(parsed.findings).toEqual([]);
	});

	it('omits absent fields rather than writing null', () => {
		// A `null` would be a type violation and therefore fatal to a
		// reader, so an absent optional must simply not appear.
		const parsed = JSON.parse(serializeManifest({ name: 'my-plugin' })) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual(['$schema', 'name']);
	});

	it('emits every metadata field when supplied', () => {
		const text = serializeManifest({
			name: 'full-plugin',
			version: '2.1.0',
			description: 'A description.',
			author: { name: 'A', email: 'a@example.com', url: 'https://example.com' },
			homepage: 'https://example.com',
			repository: 'https://github.com/example/plugin',
			license: 'MIT',
			keywords: ['a', 'b'],
			extensions: { [EVER_WORKS_EXTENSION_NAMESPACE]: { tier: 'community' } }
		});
		const parsed = validateManifest(JSON.parse(text));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.manifest.keywords).toEqual(['a', 'b']);
		expect(readExtension(parsed.manifest, EVER_WORKS_EXTENSION_NAMESPACE)).toEqual({ tier: 'community' });
	});

	it('drops empty author subfields instead of emitting empty strings', () => {
		const parsed = JSON.parse(serializeManifest({ name: 'p', author: { name: 'A', email: '' } })) as {
			author: Record<string, unknown>;
		};
		expect(parsed.author).toEqual({ name: 'A' });
	});

	it('omits an author object with nothing in it', () => {
		const parsed = JSON.parse(serializeManifest({ name: 'p', author: {} })) as Record<string, unknown>;
		expect('author' in parsed).toBe(false);
	});

	it('omits an empty keywords array and an empty extensions object', () => {
		const parsed = JSON.parse(serializeManifest({ name: 'p', keywords: [], extensions: {} })) as Record<
			string,
			unknown
		>;
		expect('keywords' in parsed).toBe(false);
		expect('extensions' in parsed).toBe(false);
	});

	it('never emits an unknown top-level field, even though a reader would tolerate one', () => {
		// Tolerated on the way in, invalid on the way out: an emitter that
		// wrote one would be producing a non-conformant package.
		const parsed = JSON.parse(serializeManifest({ name: 'p', extensions: { 'works.ever': { a: 1 } } })) as Record<
			string,
			unknown
		>;
		expect(Object.keys(parsed).sort()).toEqual(['$schema', 'extensions', 'name']);
	});

	it('can target a specific release', () => {
		const text = serializeManifest({ name: 'p' }, { specVersion: '1.1.0' });
		expect(JSON.parse(text).$schema).toBe(pluginSchemaId('1.1.0'));
	});

	it('refuses to emit an unusable plugin name', () => {
		expect(() => serializeManifest({ name: 'Bad Name' })).toThrow(/cannot be exported/);
	});

	it('ends with a newline', () => {
		expect(serializeManifest({ name: 'p' }).endsWith('}\n')).toBe(true);
	});
});

describe('serialize — SKILL.md emission', () => {
	it('emits a skill that parses back identically', () => {
		const text = serializeSkillMd({
			name: 'summarize',
			description: 'Summarize documents. Use when condensing material.',
			body: '# Steps\n\nRead, then write.\n'
		});
		const parsed = parseSkillMd(text, 'summarize');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.frontmatter.name).toBe('summarize');
		expect(parsed.body.trim()).toBe('# Steps\n\nRead, then write.');
	});

	it('serialises allowedTools back to the specification wire form', () => {
		// Tokens internally, one space-separated string on the wire. The
		// assertion is on the parsed VALUE rather than the exact bytes,
		// because YAML may legitimately quote a scalar containing `:` — a
		// quoted and an unquoted scalar carry the same value, and pinning
		// the quoting would break on any js-yaml change without telling us
		// anything about conformance.
		const text = serializeSkillMd({
			name: 's',
			description: 'd',
			body: 'b',
			allowedTools: ['Bash(git:*)', 'Read']
		});
		const parsed = parseSkillMd(text, 's');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.frontmatter['allowed-tools']).toBe('Bash(git:*) Read');
		expect(parsed.allowedTools).toEqual(['Bash(git:*)', 'Read']);
	});

	it('emits an authored-but-empty allowed-tools rather than dropping it', () => {
		// "Zero tools pre-approved" and "no policy declared" are different
		// statements to anything that gates on this field, so an empty list
		// must survive export. Absence is expressed by omitting the field.
		const emitted = serializeSkillMd({ name: 's', description: 'd', body: 'b', allowedTools: [] });
		expect(emitted).toContain('allowed-tools');
		const parsed = parseSkillMd(emitted, 's');
		expect(parsed.ok && parsed.allowedTools).toEqual([]);
		expect(serializeSkillMd({ name: 's', description: 'd', body: 'b' })).not.toContain('allowed-tools');
	});

	it('refuses an allowed-tools token containing whitespace', () => {
		// Joining on a space and re-splitting on whitespace would yield a
		// different token list, silently changing the tool policy.
		expect(() => serializeSkillMd({ name: 's', description: 'd', body: 'b', allowedTools: ['Bash(a b)'] })).toThrow(
			/space-separated/
		);
	});

	it('refuses a non-string metadata value rather than emitting an unreadable file', () => {
		expect(() =>
			serializeSkillMd({
				name: 's',
				description: 'd',
				body: 'b',
				metadata: { count: 3 } as unknown as Record<string, string>
			})
		).toThrow(/metadata/);
	});

	it('refuses a compatibility outside the Agent Skills 1-500 range', () => {
		// Emitting one would produce a SKILL.md this library's own reader
		// skips, breaking the round-trip law before anyone else sees it.
		expect(() =>
			serializeSkillMd({ name: 's', description: 'd', body: 'b', compatibility: 'c'.repeat(501) })
		).toThrow(/compatibility/);
		expect(() => serializeSkillMd({ name: 's', description: 'd', body: 'b', compatibility: '' })).toThrow(
			/compatibility/
		);
	});

	it('preserves the body byte for byte, including the blank line after the frontmatter', () => {
		const original = ORIGINAL_SKILL;
		const parsed = parseSkillMd(original, 's');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(serializeSkillMd(skillToSerializeInput(parsed.frontmatter, parsed.body))).toBe(original);
	});

	it('writes known fields in a fixed order so re-export is byte-identical', () => {
		const input = {
			name: 's',
			description: 'd',
			body: 'b',
			license: 'MIT',
			compatibility: 'Needs git',
			metadata: { author: 'org' },
			allowedTools: ['Read']
		};
		expect(serializeSkillMd(input)).toBe(serializeSkillMd(input));
		const lines = serializeSkillMd(input).split('\n');
		expect(lines[1]?.startsWith('name:')).toBe(true);
		expect(lines[2]?.startsWith('description:')).toBe(true);
	});

	it('preserves unknown frontmatter keys, sorted for determinism', () => {
		const text = serializeSkillMd({
			name: 's',
			description: 'd',
			body: 'b',
			extraFrontmatter: { zeta: '1', alpha: '2' }
		});
		expect(text.indexOf('alpha:')).toBeLessThan(text.indexOf('zeta:'));
		const parsed = parseSkillMd(text, 's');
		expect(parsed.ok && parsed.frontmatter['alpha']).toBe('2');
	});

	it('never lets an extra key overwrite a known field', () => {
		const text = serializeSkillMd({
			name: 'real',
			description: 'd',
			body: 'b',
			extraFrontmatter: { name: 'hijacked', description: 'hijacked' }
		});
		const parsed = parseSkillMd(text, 'real');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.frontmatter.name).toBe('real');
		expect(parsed.frontmatter.description).toBe('d');
	});

	it('refuses an unusable skill name, an empty description and an over-long description', () => {
		expect(() => serializeSkillMd({ name: 'Bad', description: 'd', body: 'b' })).toThrow();
		expect(() => serializeSkillMd({ name: 's', description: '   ', body: 'b' })).toThrow(/description/);
		expect(() => serializeSkillMd({ name: 's', description: 'd'.repeat(1025), body: 'b' })).toThrow(/1024/);
	});

	it('quotes a description that YAML would otherwise mis-parse', () => {
		const tricky = 'Uses a: colon, a #hash and a "quote". Use when parsing is hard.';
		const parsed = parseSkillMd(serializeSkillMd({ name: 's', description: tricky, body: 'b' }), 's');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.frontmatter.description).toBe(tricky);
	});
});

describe('serialize — name narrowing (spec 5.5 and the Agent Skills name rule)', () => {
	it('passes a slug that is already legal through untouched', () => {
		expect(toSpecSkillName('code-review')).toEqual({ ok: true, name: 'code-review' });
	});

	it.each([
		['-leading', 'leading', 'starts or ends with a hyphen'],
		['trailing-', 'trailing', 'starts or ends with a hyphen'],
		['double--hyphen', 'double-hyphen', 'consecutive hyphens'],
		['Upper-Case', 'upper-case', 'characters outside']
	])('refuses %j, suggesting %j', (slug, suggestion, reasonFragment) => {
		const result = toSpecSkillName(slug);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.suggestion).toBe(suggestion);
		expect(result.reason).toContain(reasonFragment);
		expect(result.finding.code).toBe('export.skill-name-unusable');
	});

	it('refuses an Ever Works slug that is legal internally but too long for the standard', () => {
		// The Ever Works slug rule allows 80 characters; the Agent Skills
		// rule allows 64. That gap is the whole reason this guard exists.
		const slug = 'a'.repeat(80);
		const result = toSpecSkillName(slug);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.suggestion).toBe('a'.repeat(64));
		expect(result.reason).toContain('64');
	});

	it('always suggests a name that actually passes the rule', () => {
		for (const slug of ['-a-', 'a--b--c', 'A_B', 'a'.repeat(90), '--x--']) {
			const result = toSpecSkillName(slug);
			if (result.ok || result.suggestion === undefined) {
				continue;
			}
			expect(toSpecSkillName(result.suggestion).ok).toBe(true);
		}
	});

	it('offers no suggestion when nothing usable can be salvaged', () => {
		const result = toSpecSkillName('---');
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.suggestion).toBeUndefined();
	});

	it('allows periods for a plugin name but not for a skill name', () => {
		expect(toSpecPluginName('acme.tools').ok).toBe(true);
		expect(toSpecSkillName('acme.tools').ok).toBe(false);
	});

	it('repairs consecutive periods in a plugin name', () => {
		const result = toSpecPluginName('too.many..dots');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.suggestion).toBe('too.many.dots');
		expect(toSpecPluginName(result.suggestion ?? '').ok).toBe(true);
	});
});

describe('serialize — the round-trip law (export then import is identity)', () => {
	it('survives a full package round trip through the loader', async () => {
		const source = await discoverSkills(fixture('valid-full'));
		expect(source.skills.length).toBeGreaterThan(0);

		const root = await scratchDir();
		await writeFile(
			join(root, 'plugin.json'),
			serializeManifest({
				name: 'round-trip',
				version: '1.0.0',
				extensions: { [EVER_WORKS_EXTENSION_NAMESPACE]: { origin: 'test' } }
			}),
			'utf8'
		);
		for (const skill of source.skills) {
			const dir = join(root, 'skills', skill.name);
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, 'SKILL.md'),
				serializeSkillMd(skillToSerializeInput(skill.frontmatter, skill.body)),
				'utf8'
			);
		}

		const reloaded = await discoverSkills(root);
		expect(reloaded.findings).toEqual([]);
		expect(reloaded.skills.map((s) => s.name)).toEqual(source.skills.map((s) => s.name));

		for (const [index, skill] of reloaded.skills.entries()) {
			const original = source.skills[index];
			expect(skill.frontmatter).toEqual(original?.frontmatter);
			expect(skill.body.trim()).toEqual(original?.body.trim());
			expect(skill.allowedTools).toEqual(original?.allowedTools);
		}
	});

	it('is idempotent: a second emission of parsed output is byte-identical', () => {
		const first = serializeSkillMd({
			name: 's',
			description: 'A description.',
			body: 'Body.\n',
			license: 'MIT',
			metadata: { a: 'b' },
			allowedTools: ['Read', 'Write']
		});
		const parsed = parseSkillMd(first, 's');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const second = serializeSkillMd(skillToSerializeInput(parsed.frontmatter, parsed.body));
		expect(second).toBe(first);
	});

	it('rebuilds serializer input from parsed frontmatter without losing unknown keys', () => {
		const parsed = parseSkillMd('---\nname: s\ndescription: d\nx-vendor: keep\n---\n\nBody.\n', 's');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const input = skillToSerializeInput(parsed.frontmatter, parsed.body);
		expect(input.extraFrontmatter).toEqual({ 'x-vendor': 'keep' });
	});
});

describe('serialize — the Ever Works namespace', () => {
	it('is the reverse of the ever.works domain', () => {
		expect(EVER_WORKS_EXTENSION_NAMESPACE).toBe('works.ever');
	});

	it('refuses to emit an extension namespace that is not reverse-domain', () => {
		// A reader must ignore namespaces it does not implement WITHOUT
		// validating them (spec 8.1), so a malformed key would sail through
		// every importer unreported. The producer is the only place to catch it.
		expect(() => serializeManifest({ name: 'p', extensions: { mystuff: { a: 1 } } })).toThrow(/reverse-domain/);
		expect(() => serializeManifest({ name: 'p', extensions: { 'works.ever': { a: 1 } } })).not.toThrow();
	});

	it('returns undefined for a namespace the package does not carry', () => {
		const parsed = validateManifest(JSON.parse(serializeManifest({ name: 'p' })));
		expect(parsed.ok && readExtension(parsed.manifest, 'works.ever')).toBeUndefined();
	});
});
