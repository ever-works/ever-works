/**
 * End-to-end conformance, walked over the fixture corpus.
 *
 * Where the sibling suites test one validator at a time, this one drives
 * {@link loadPluginPackage} — the entry point every later phase actually
 * calls — and asserts the properties the specification states about a
 * *package*: the fatal/non-fatal boundary, failure isolation between
 * component types, and the Appendix A checklist.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codes, FIXTURES_DIR, fixture } from './fixtures';
import { CONFORMANCE_CLAIM } from '../index';
import { loadPluginPackage, summarizeLoad } from '../package-loader';
import {
	mcpSchemaId,
	pluginSchemaId,
	PUBLISHED_CONFORMANCE_VERSION,
	specVersionFromMcpSchemaId,
	specVersionFromPluginSchemaId,
	SUPPORTED_SPEC_VERSIONS,
	WORKING_DRAFT_VERSIONS
} from '../versions';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const names = (items: readonly { name: string }[]): string[] => items.map((i) => i.name).sort();

describe('conformance — the version registry (spec 5.2, 7.2.1, 10.1)', () => {
	it('supports 1.0.0 and 1.1.0, and publishes its claim against 1.0.0', () => {
		expect(SUPPORTED_SPEC_VERSIONS).toEqual(['1.0.0', '1.1.0']);
		expect(PUBLISHED_CONFORMANCE_VERSION).toBe('1.0.0');
		expect(WORKING_DRAFT_VERSIONS).toEqual(['1.1.0']);
	});

	it('round-trips every canonical identifier it claims to support', () => {
		for (const version of SUPPORTED_SPEC_VERSIONS) {
			expect(specVersionFromPluginSchemaId(pluginSchemaId(version))).toBe(version);
			expect(specVersionFromMcpSchemaId(mcpSchemaId(version))).toBe(version);
		}
	});

	it('does not accept a plugin identifier where an MCP one belongs, or the reverse', () => {
		expect(specVersionFromMcpSchemaId(pluginSchemaId('1.0.0'))).toBeUndefined();
		expect(specVersionFromPluginSchemaId(mcpSchemaId('1.0.0'))).toBeUndefined();
	});

	it('rejects unknown, malformed and non-string identifiers', () => {
		for (const id of [
			'https://agent-plugins.org/schemas/0.9.0/plugin.schema.json',
			'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
			'http://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
			'https://evil.example.com/schemas/1.0.0/plugin.schema.json',
			'plugin.schema.json',
			'',
			null,
			undefined,
			42,
			{}
		]) {
			expect(specVersionFromPluginSchemaId(id)).toBeUndefined();
		}
	});

	it('vendors a schema whose declared $id matches the identifier it is registered under', async () => {
		// A mismatch here would mean validating a document against the wrong
		// release while reporting the right one.
		for (const version of SUPPORTED_SPEC_VERSIONS) {
			for (const [file, expected] of [
				['plugin.schema.json', pluginSchemaId(version)],
				['mcp.schema.json', mcpSchemaId(version)]
			] as const) {
				const text = await readFile(join(SRC_DIR, 'schemas', version, file), 'utf8');
				const schema = JSON.parse(text) as { $id: string; properties: { $schema: { const: string } } };
				expect(schema.$id).toBe(expected);
				// The schema also pins its own identifier as a const, and the
				// two must agree or a valid document would fail validation.
				expect(schema.properties.$schema.const).toBe(expected);
			}
		}
	});

	it('states the conformance claim verbatim', () => {
		expect(CONFORMANCE_CLAIM).toBe(
			'Agent Plugins v1.0.0 compatible (client: skills + MCP; producer: skills packages, plus the Ever Works MCP-server package descriptor)'
		);
	});
});

describe('conformance — packages that load (spec 11.1)', () => {
	it('loads a package from a directory path with only a manifest', async () => {
		const result = await loadPluginPackage(fixture('valid-minimal'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.name).toBe('minimal-plugin');
		expect(result.specVersion).toBe('1.0.0');
		expect(result.skills).toEqual([]);
		expect(result.mcpServers).toEqual([]);
		expect(result.skillsComponent.absent).toBe(true);
		expect(result.mcpComponent.absent).toBe(true);
		expect(result.findings).toEqual([]);
	});

	it('loads both component types from a full package', async () => {
		const result = await loadPluginPackage(fixture('valid-full'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(names(result.skills)).toEqual(['deploy', 'summarize']);
		expect(names(result.mcpServers)).toEqual(['deployment-api', 'legacy-events', 'local-validator']);
		expect(result.findings).toEqual([]);
		expect(summarizeLoad(result)).toEqual({
			accepted: true,
			skillCount: 2,
			mcpServerCount: 3,
			fatalCount: 0,
			errorCount: 0,
			warningCount: 0
		});
	});

	it('loads a package targeting the recognised-compatible 1.1.0 release', async () => {
		const result = await loadPluginPackage(fixture('valid-spec-1-1-0'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.specVersion).toBe('1.1.0');
		expect(names(result.skills)).toEqual(['works']);
		expect(names(result.mcpServers)).toEqual(['api']);
		expect(result.findings).toEqual([]);
	});

	it.each([
		'valid-name-single-char',
		'valid-name-dotted',
		'valid-name-max-length',
		'valid-lenient-metadata',
		'valid-unimplemented-extension',
		'valid-empty-mcp-servers',
		'valid-no-components',
		'valid-loopback-http'
	])('loads %s', async (name) => {
		const result = await loadPluginPackage(fixture(name));
		expect(result.ok).toBe(true);
	});

	it('loads despite an unknown top-level manifest field, and still discovers skills', async () => {
		const result = await loadPluginPackage(fixture('valid-unknown-top-level-field'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(names(result.skills)).toEqual(['still-loads']);
		expect(codes(result.findings)).toContain('manifest.unknown-field');
		// An inline `mcpServers` in plugin.json is one of the unknown fields:
		// spec 7.2.1 forbids inline MCP configuration, and ignoring the key
		// must not cause us to load anything from it.
		expect(result.mcpServers).toEqual([]);
	});

	it('loads despite a non-object extensions field, and still discovers skills', async () => {
		const result = await loadPluginPackage(fixture('valid-extensions-not-an-object'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(names(result.skills)).toEqual(['still-loads']);
		expect(codes(result.findings)).toContain('manifest.extensions-not-an-object');
	});
});

describe('conformance — a fatal manifest discovers nothing (spec 5.3, 11.3.2)', () => {
	it('rejects a package with no manifest even though it has a valid skill', async () => {
		const result = await loadPluginPackage(fixture('fatal-missing-manifest'));
		expect(result.ok).toBe(false);
		expect(codes(result.findings)).toEqual(['manifest.missing']);
		// The structural guarantee: a rejected result has no skills field at
		// all, so a caller cannot use partial data by accident.
		expect('skills' in result).toBe(false);
	});

	it('rejects a non-existent or non-directory root', async () => {
		const missing = await loadPluginPackage(fixture('does-not-exist-at-all'));
		expect(missing.ok).toBe(false);
		expect(codes(missing.findings)).toEqual(['package.root-unreadable']);
		const notADir = await loadPluginPackage(join(fixture('valid-minimal'), 'plugin.json'));
		expect(notADir.ok).toBe(false);
	});

	it('rejects every fatal- fixture and discovers nothing from any of them', async () => {
		const entries = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
			.filter((e) => e.isDirectory() && e.name.startsWith('fatal-'))
			.map((e) => e.name);
		// Guard against the corpus silently emptying and this test passing
		// vacuously.
		expect(entries.length).toBeGreaterThanOrEqual(20);

		for (const name of entries) {
			const result = await loadPluginPackage(fixture(name));
			expect(result.ok, `${name} must be rejected`).toBe(false);
			expect(
				result.findings.some((f) => f.severity === 'fatal'),
				`${name} must report a fatal finding`
			).toBe(true);
			expect('skills' in result, `${name} must expose no components`).toBe(false);
		}
	});
});

describe('conformance — failure isolation between component types (spec 11.3.3)', () => {
	it('keeps skills when the MCP document is unusable', async () => {
		for (const name of ['mcp-invalid-json', 'mcp-version-mismatch']) {
			const result = await loadPluginPackage(fixture(name));
			expect(result.ok, name).toBe(true);
			if (!result.ok) continue;
			expect(names(result.skills), name).toEqual(['survivor']);
			expect(result.mcpComponent.valid, name).toBe(false);
			expect(result.mcpServers, name).toEqual([]);
		}
	});

	it('keeps MCP servers when the skills location is unusable', async () => {
		const result = await loadPluginPackage(fixture('skills-location-not-a-directory'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.skillsComponent.valid).toBe(false);
		expect(result.skills).toEqual([]);
		expect(names(result.mcpServers)).toEqual(['api']);
	});

	it('never reports a fatal finding from below the manifest', async () => {
		// Fatal means "discover nothing", and by the time components are
		// walked discovery has already happened — so a fatal finding there
		// would be a contract violation, not just a bad message.
		const entries = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
			.filter((e) => e.isDirectory() && !e.name.startsWith('fatal-'))
			.map((e) => e.name);
		expect(entries.length).toBeGreaterThanOrEqual(20);

		for (const name of entries) {
			const result = await loadPluginPackage(fixture(name));
			expect(result.ok, `${name} must not be rejected`).toBe(true);
			expect(
				result.findings.every((f) => f.severity !== 'fatal'),
				`${name} must raise no fatal finding`
			).toBe(true);
		}
	});

	it('never throws for any fixture in the corpus', async () => {
		const entries = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
		for (const name of entries) {
			await expect(loadPluginPackage(fixture(name)), name).resolves.toBeDefined();
		}
	});
});

describe('conformance — incremental adoption (spec 11.2)', () => {
	it('supports a skills-only client, ignoring mcp.json entirely', async () => {
		const result = await loadPluginPackage(fixture('valid-full'), {
			components: { skills: true, mcpServers: false }
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(names(result.skills)).toEqual(['deploy', 'summarize']);
		expect(result.mcpServers).toEqual([]);
		expect(result.mcpComponent.unsupported).toBe(true);
	});

	it('supports an MCP-only client, ignoring skills entirely', async () => {
		const result = await loadPluginPackage(fixture('valid-full'), {
			components: { skills: false, mcpServers: true }
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.skills).toEqual([]);
		expect(result.skillsComponent.unsupported).toBe(true);
		expect(names(result.mcpServers)).toEqual(['deployment-api', 'legacy-events', 'local-validator']);
	});

	it('does not report an MCP problem to a skills-only client', async () => {
		// "lack of support for a component type ... is not itself an error"
		// (spec 11.3.4) — and a client that cannot use MCP should not be
		// told a package's MCP configuration is broken.
		const result = await loadPluginPackage(fixture('mcp-invalid-json'), {
			components: { skills: true, mcpServers: false }
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.findings.every((f) => f.scope !== 'mcp-component')).toBe(true);
	});

	it('refuses to be constructed with no component type at all (spec 11.1.8)', async () => {
		await expect(
			loadPluginPackage(fixture('valid-minimal'), { components: { skills: false, mcpServers: false } })
		).rejects.toThrow(/at least one supported component type/);
	});

	it('narrows the transports it will accept', async () => {
		const result = await loadPluginPackage(fixture('valid-full'), {
			supportedTransports: ['stdio', 'streamable-http']
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(names(result.mcpServers)).toEqual(['deployment-api', 'local-validator']);
		expect(codes(result.findings)).toEqual(['mcp.server-transport-unsupported']);
	});
});

describe('conformance — the loaded root is filesystem-resolved (spec 4.1)', () => {
	it('reports an absolute, resolved root that every containment check is relative to', async () => {
		const result = await loadPluginPackage(fixture('valid-full'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.root).toMatch(/valid-full$/);
		for (const skill of result.skills) {
			expect(skill.dir.startsWith(result.root)).toBe(true);
			expect(skill.skillMdPath.startsWith(result.root)).toBe(true);
		}
	});
});

describe('conformance — Appendix A checklist', () => {
	// One assertion per checklist row, so a reviewer can map the list to
	// evidence without reading the whole suite. Rows about subprocess launch
	// (providing PLUGIN_ROOT/PLUGIN_DATA, resolving a bare command through
	// the platform search) belong to the phase that launches processes; the
	// parsing and expansion halves are covered here and in expand.spec.ts.

	it('parses and validates plugin.json, including the required fields and name rule', async () => {
		expect((await loadPluginPackage(fixture('valid-minimal'))).ok).toBe(true);
		expect((await loadPluginPackage(fixture('fatal-manifest-name-uppercase'))).ok).toBe(false);
		expect((await loadPluginPackage(fixture('fatal-manifest-schema-missing'))).ok).toBe(false);
	});

	it('reports and ignores unknown plugin.json fields', async () => {
		const result = await loadPluginPackage(fixture('valid-unknown-top-level-field'));
		expect(result.ok).toBe(true);
		expect(codes(result.findings)).toContain('manifest.unknown-field');
	});

	it('ignores unimplemented extension namespaces without validating their contents', async () => {
		const result = await loadPluginPackage(fixture('valid-unimplemented-extension'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.findings).toEqual([]);
		expect(result.manifest.extensions?.['com.other.client']).toBeDefined();
	});

	it('scans the fixed location for each supported component type', async () => {
		const result = await loadPluginPackage(fixture('valid-full'));
		expect(result.ok && result.skills.length).toBe(2);
		expect(result.ok && result.mcpServers.length).toBe(3);
	});

	it('ignores missing fixed locations without error', async () => {
		const result = await loadPluginPackage(fixture('valid-no-components'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.findings).toEqual([]);
		expect(result.skillsComponent.absent).toBe(true);
		expect(result.mcpComponent.absent).toBe(true);
	});

	it('selects a supported $schema then validates mcp.json and each server variant', async () => {
		expect((await loadPluginPackage(fixture('mcp-schema-unsupported'))).ok).toBe(true);
		const unsupported = await loadPluginPackage(fixture('mcp-schema-unsupported'));
		expect(unsupported.ok && unsupported.mcpComponent.valid).toBe(false);
		const perEntry = await loadPluginPackage(fixture('mcp-skip-servers'));
		expect(perEntry.ok && perEntry.mcpComponent.valid).toBe(true);
		expect(perEntry.ok && names(perEntry.mcpServers)).toEqual(['good', 'good-stdio']);
	});

	it('implements both stdio and Streamable HTTP, and also legacy SSE', async () => {
		const result = await loadPluginPackage(fixture('mcp-transport-filtering'));
		expect(result.ok && names(result.mcpServers)).toEqual(['legacy', 'local', 'remote']);
	});

	it('keeps each entry on its declared transport, with no fallback', async () => {
		const result = await loadPluginPackage(fixture('valid-full'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mcpServers.map((s) => `${s.name}:${s.transport}`).sort()).toEqual([
			'deployment-api:streamable-http',
			'legacy-events:sse',
			'local-validator:stdio'
		]);
	});

	it('enforces remote URL and literal-header requirements', async () => {
		const result = await loadPluginPackage(fixture('mcp-skip-servers'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const found = new Set(codes(result.findings));
		expect(found.has('mcp.server-url-invalid')).toBe(true);
		expect(found.has('mcp.server-header-duplicate')).toBe(true);
		expect(found.has('mcp.server-header-name-invalid')).toBe(true);
	});

	it('resolves an MCP server command as a single bare or plugin-relative token', async () => {
		const result = await loadPluginPackage(fixture('mcp-skip-servers'));
		expect(result.ok && codes(result.findings)).toContain('mcp.server-command-invalid');
	});

	it('validates explicit cwd forms', async () => {
		const result = await loadPluginPackage(fixture('mcp-skip-servers'));
		expect(result.ok && codes(result.findings)).toContain('mcp.server-cwd-invalid');
	});

	it('leaves the default working directory implicit, meaning the plugin root', async () => {
		const result = await loadPluginPackage(fixture('mcp-transport-filtering'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const local = result.mcpServers.find((s) => s.name === 'local');
		expect(local?.cwdAnchor).toBeUndefined();
	});

	it('rejects an env object that sets a reserved name', async () => {
		const result = await loadPluginPackage(fixture('mcp-skip-servers'));
		expect(result.ok && codes(result.findings)).toContain('mcp.server-env-reserved-key');
	});

	it('ignores unsupported component types and continues when one fails', async () => {
		const result = await loadPluginPackage(fixture('skills-frontmatter-cases'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.skills.length).toBeGreaterThan(0);
		expect(result.findings.length).toBeGreaterThan(0);
	});

	it('supports at least one component type', async () => {
		const result = await loadPluginPackage(fixture('valid-full'));
		expect(result.ok && (result.skills.length > 0 || result.mcpServers.length > 0)).toBe(true);
	});
});

describe('conformance — summary reporting', () => {
	it('counts findings by severity for a UI', async () => {
		const result = await loadPluginPackage(fixture('mcp-skip-servers'));
		const summary = summarizeLoad(result);
		expect(summary.accepted).toBe(true);
		expect(summary.mcpServerCount).toBe(2);
		expect(summary.errorCount).toBeGreaterThan(0);
		expect(summary.fatalCount).toBe(0);
	});

	it('reports zero components for a rejected package', async () => {
		const summary = summarizeLoad(await loadPluginPackage(fixture('fatal-missing-manifest')));
		expect(summary).toEqual({
			accepted: false,
			skillCount: 0,
			mcpServerCount: 0,
			fatalCount: 1,
			errorCount: 0,
			warningCount: 0
		});
	});
});
