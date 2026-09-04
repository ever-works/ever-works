import { describe, expect, it } from 'vitest';
import { codes } from './fixtures';
import { isValidPluginName, parseManifest, PERMITTED_MANIFEST_FIELDS, validateManifest } from '../manifest';
import { pluginSchemaId } from '../versions';

const SCHEMA = pluginSchemaId('1.0.0');

const base = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	$schema: SCHEMA,
	name: 'example-plugin',
	...extra
});

describe('manifest — the severity split of spec 5.2', () => {
	it('accepts the minimal manifest: $schema and name are the only required fields', () => {
		const result = validateManifest({ $schema: SCHEMA, name: 'minimal-plugin' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.name).toBe('minimal-plugin');
		expect(result.specVersion).toBe('1.0.0');
		expect(result.findings).toEqual([]);
	});

	it('reports an unknown top-level field, ignores it, and keeps loading', () => {
		const result = validateManifest(base({ futureThing: 42 }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(codes(result.findings)).toEqual(['manifest.unknown-field']);
		expect(result.findings[0]?.severity).toBe('warning');
		expect(result.findings[0]?.subject).toBe('futureThing');
		// Ignored means genuinely absent, not merely unvalidated: nothing
		// downstream may assign semantics to it (spec 5.2).
		expect('futureThing' in result.manifest).toBe(false);
	});

	it('reports every unknown field, not just the first', () => {
		const result = validateManifest(base({ a: 1, b: 2, c: 3 }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.findings).toHaveLength(3);
	});

	it('reports a non-object extensions field, ignores it, and keeps loading', () => {
		const result = validateManifest(base({ extensions: 'nope' }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(codes(result.findings)).toEqual(['manifest.extensions-not-an-object']);
		expect(result.findings[0]?.severity).toBe('warning');
		expect(result.manifest.extensions).toBeUndefined();
	});

	it.each([
		['an array extensions field', []],
		['a null extensions field', null],
		['a numeric extensions field', 7]
	])('treats %s as the tolerated non-object case', (_label, value) => {
		const result = validateManifest(base({ extensions: value }));
		expect(result.ok).toBe(true);
	});

	it('carries an unimplemented extension namespace through without validating its contents', () => {
		const extensions = { 'com.other.client': { anything: [1, 2, { nested: null }] } };
		const result = validateManifest(base({ extensions }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.extensions).toEqual(extensions);
		expect(result.findings).toEqual([]);
	});

	it('is fatal when an extension NAMESPACE value is not an object', () => {
		// The leniency of spec 8.1 covers the `extensions` field itself. A
		// namespace whose value is not an object is an ordinary schema
		// violation, and spec 5.2 makes those fatal.
		const result = validateManifest(base({ extensions: { 'com.example.client': 5 } }));
		expect(result.ok).toBe(false);
		expect(result.findings.some((f) => f.severity === 'fatal')).toBe(true);
	});

	it('is fatal when the document is not a top-level object', () => {
		for (const value of [[], 'string', 7, null, true]) {
			const result = validateManifest(value);
			expect(result.ok).toBe(false);
			expect(codes(result.findings)).toEqual(['manifest.not-an-object']);
		}
	});

	it('is fatal when $schema is missing', () => {
		const result = validateManifest({ name: 'no-schema' });
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['manifest.schema-missing']);
	});

	it('is fatal when $schema names an unsupported version, and says which are supported', () => {
		const result = validateManifest({
			$schema: 'https://agent-plugins.org/schemas/9.9.9/plugin.schema.json',
			name: 'from-the-future'
		});
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['manifest.schema-unsupported']);
		expect(result.findings[0]?.message).toContain('1.0.0');
	});

	it('is fatal when $schema is not a string', () => {
		const result = validateManifest({ $schema: 1, name: 'x' });
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['manifest.schema-unsupported']);
	});

	it('is fatal when name is missing', () => {
		const result = validateManifest({ $schema: SCHEMA });
		expect(result.ok).toBe(false);
		expect(result.findings.some((f) => f.severity === 'fatal')).toBe(true);
	});

	it('rejects a fatal manifest before any component discovery could occur', () => {
		// Structural guarantee of spec 5.3 / 11.3.2: a rejected manifest
		// yields no manifest object at all, so a caller cannot accidentally
		// proceed with partial data.
		const result = validateManifest({ $schema: SCHEMA, name: 'BAD NAME' });
		expect(result.ok).toBe(false);
		expect('manifest' in result).toBe(false);
	});

	it('still reports non-fatal findings alongside a fatal one', () => {
		const result = validateManifest({ $schema: SCHEMA, name: '-bad', unknownThing: 1 });
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toContain('manifest.unknown-field');
		expect(codes(result.findings)).toContain('manifest.name-invalid');
	});
});

describe('manifest — what a client MUST NOT reject (spec 5.4)', () => {
	it('accepts a version that is not semantic versioning', () => {
		const result = validateManifest(base({ version: 'not-semver-at-all' }));
		expect(result.ok).toBe(true);
	});

	it('accepts unrecognisable homepage, repository and author.url values', () => {
		const result = validateManifest(
			base({ homepage: 'definitely not a url', repository: '???', author: { url: 'nope' } })
		);
		expect(result.ok).toBe(true);
	});

	it('accepts an author.email that is not an email address', () => {
		expect(validateManifest(base({ author: { email: 'not-an-email' } })).ok).toBe(true);
	});

	it('accepts a license that is not an SPDX identifier', () => {
		expect(validateManifest(base({ license: 'Free-For-All-2000' })).ok).toBe(true);
	});
});

describe('manifest — the closed author object (spec 5.4)', () => {
	it('accepts the three permitted string fields', () => {
		const result = validateManifest(
			base({ author: { name: 'A', email: 'a@example.com', url: 'https://example.com' } })
		);
		expect(result.ok).toBe(true);
	});

	it('is fatal for an unknown author subfield', () => {
		const result = validateManifest(base({ author: { name: 'A', twitter: '@a' } }));
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['manifest.schema-violation']);
		// The message must name the offending subfield: an operator cannot
		// act on "the manifest is invalid".
		expect(result.findings[0]?.message).toContain('twitter');
	});

	it('is fatal for a non-string author subfield', () => {
		expect(validateManifest(base({ author: { name: 5 } })).ok).toBe(false);
	});

	it('is fatal when author is not an object at all', () => {
		expect(validateManifest(base({ author: 'Author Name' })).ok).toBe(false);
	});
});

describe('manifest — plugin name constraints (spec 5.5)', () => {
	it.each(['my-plugin', 'acme.tools', 'lint3r', 'a', '0', 'a-b.c-d', 'a'.repeat(64)])(
		'accepts the valid name %j',
		(name) => {
			expect(isValidPluginName(name)).toBe(true);
			expect(validateManifest({ $schema: SCHEMA, name }).ok).toBe(true);
		}
	);

	it.each([
		['My-Plugin', 'uppercase'],
		['-start', 'leading hyphen'],
		['end-', 'trailing hyphen'],
		['.start', 'leading period'],
		['end.', 'trailing period'],
		['has--double', 'consecutive hyphens'],
		['too.many..dots', 'consecutive periods'],
		['', 'empty'],
		['has space', 'whitespace'],
		['has_underscore', 'underscore'],
		['a'.repeat(65), 'over 64 characters']
	])('rejects %j (%s)', (name) => {
		expect(isValidPluginName(name)).toBe(false);
		expect(validateManifest({ $schema: SCHEMA, name }).ok).toBe(false);
	});

	it('rejects a non-string name', () => {
		expect(isValidPluginName(42)).toBe(false);
		expect(isValidPluginName(null)).toBe(false);
		expect(isValidPluginName(undefined)).toBe(false);
	});

	it('attributes a bad name to the name field so a UI can point at it', () => {
		const result = validateManifest({ $schema: SCHEMA, name: 'has--double' });
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['manifest.name-invalid']);
		expect(result.findings[0]?.at).toBe('/name');
	});
});

describe('manifest — field types', () => {
	it.each([
		['keywords as a string', { keywords: 'one two' }],
		['a non-string keyword', { keywords: ['ok', 7] }],
		['a numeric version', { version: 120 }],
		['a numeric description', { description: 5 }],
		['a boolean license', { license: true }]
	])('is fatal for %s', (_label, extra) => {
		expect(validateManifest(base(extra)).ok).toBe(false);
	});

	it('accepts an empty keywords array', () => {
		expect(validateManifest(base({ keywords: [] })).ok).toBe(true);
	});
});

describe('manifest — text parsing', () => {
	it('is fatal for invalid JSON and names the parse problem', () => {
		const result = parseManifest('{ "name": "broken", }');
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['manifest.invalid-json']);
	});

	it('parses a valid document', () => {
		const result = parseManifest(JSON.stringify({ $schema: SCHEMA, name: 'ok' }));
		expect(result.ok).toBe(true);
	});

	it('exposes the permitted field list in specification order', () => {
		expect(PERMITTED_MANIFEST_FIELDS).toEqual([
			'$schema',
			'name',
			'version',
			'description',
			'author',
			'homepage',
			'repository',
			'license',
			'keywords',
			'extensions'
		]);
	});
});
