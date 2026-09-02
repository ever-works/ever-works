import { describe, expect, it } from 'vitest';
import { MODEL_CLI_ENV_OVERRIDES, resolveModelCliPaths, type ModelCliProbeIo } from './model-cli-probe';

/**
 * Which model CLIs a node advertises — and therefore which it will spawn.
 *
 * The rule under test: a pinned path that does not resolve DISABLES the
 * CLI. Falling back to PATH would let a run succeed on a binary the
 * operator explicitly did not choose.
 */
function io(
	over: Partial<ModelCliProbeIo> & { hits?: Record<string, string[]>; files?: string[] } = {}
): ModelCliProbeIo {
	const files = new Set(over.files ?? []);
	const hits = over.hits ?? {};
	return {
		env: over.env ?? {},
		platform: over.platform ?? 'linux',
		fileExists: over.fileExists ?? ((path) => files.has(path)),
		lookupAllOnPath: over.lookupAllOnPath ?? ((command) => hits[command] ?? [])
	};
}

describe('resolveModelCliPaths', () => {
	it('finds both CLIs on PATH', () => {
		const out = resolveModelCliPaths(io({ hits: { claude: ['/usr/bin/claude'], codex: ['/usr/bin/codex'] } }));
		expect(out.paths).toEqual({ 'claude-code': '/usr/bin/claude', codex: '/usr/bin/codex' });
		expect(out.notes).toEqual(['claude-code: /usr/bin/claude (PATH)', 'codex: /usr/bin/codex (PATH)']);
	});

	it('reports a missing CLI as null with a note, never as an error', () => {
		const out = resolveModelCliPaths(io({ hits: { claude: ['/usr/bin/claude'] } }));
		expect(out.paths).toEqual({ 'claude-code': '/usr/bin/claude', codex: null });
		expect(out.notes[1]).toBe('codex: not found on PATH');
	});

	it('honours an env pin that exists', () => {
		const out = resolveModelCliPaths(
			io({
				env: { [MODEL_CLI_ENV_OVERRIDES['claude-code']]: '/opt/claude/bin/claude' },
				files: ['/opt/claude/bin/claude']
			})
		);
		expect(out.paths['claude-code']).toBe('/opt/claude/bin/claude');
		expect(out.notes[0]).toContain('(pinned)');
	});

	it('DISABLES a CLI whose pin does not resolve instead of falling back to PATH', () => {
		const out = resolveModelCliPaths(
			io({ env: { [MODEL_CLI_ENV_OVERRIDES.codex]: '/nope/codex' }, hits: { codex: ['/usr/bin/codex'] } })
		);
		expect(out.paths.codex).toBeNull();
		expect(out.notes[1]).toContain('disabled');
	});

	it('explicit overrides beat env pins', () => {
		const out = resolveModelCliPaths(
			io({
				env: { [MODEL_CLI_ENV_OVERRIDES['claude-code']]: '/env/claude' },
				files: ['/flag/claude', '/env/claude']
			}),
			{ 'claude-code': '/flag/claude' }
		);
		expect(out.paths['claude-code']).toBe('/flag/claude');
	});

	it('on Windows prefers a .cmd/.exe hit over the extension-less npm shim', () => {
		const out = resolveModelCliPaths(
			io({
				platform: 'win32',
				hits: { claude: ['C:\\npm\\claude', 'C:\\npm\\claude.cmd'] }
			})
		);
		expect(out.paths['claude-code']).toBe('C:\\npm\\claude.cmd');
	});

	it('on Windows falls back to the sibling .cmd when `where` lists only the shim', () => {
		const out = resolveModelCliPaths(
			io({ platform: 'win32', hits: { claude: ['C:\\npm\\claude'] }, files: ['C:\\npm\\claude.cmd'] })
		);
		expect(out.paths['claude-code']).toBe('C:\\npm\\claude.cmd');
	});

	it('on Windows reports nothing launchable when only the shim exists', () => {
		const out = resolveModelCliPaths(io({ platform: 'win32', hits: { claude: ['C:\\npm\\claude'] } }));
		expect(out.paths['claude-code']).toBeNull();
	});

	it('works with a single-hit lookup', () => {
		const out = resolveModelCliPaths({
			env: {},
			platform: 'linux',
			fileExists: () => false,
			lookupOnPath: (command) => (command === 'codex' ? '/usr/bin/codex' : null)
		});
		expect(out.paths).toEqual({ 'claude-code': null, codex: '/usr/bin/codex' });
	});
});
