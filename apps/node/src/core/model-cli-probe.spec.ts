import { describe, expect, it } from 'vitest';
import {
	MODEL_CLI_ENV_OVERRIDES,
	probeModelCliPaths,
	resolveModelCliPaths,
	type ModelCliProbeIo,
	type PathSearchResult
} from './model-cli-probe';

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

describe('resolveModelCliPaths — pinned paths are held to the launchability rule (review follow-up)', () => {
	it('on Windows disables a pin that is not a .cmd/.exe/.bat, even when the file exists', () => {
		const out = resolveModelCliPaths(
			io({ platform: 'win32', files: ['C:\npm\claude'], hits: { claude: ['C:\npm\claude.cmd'] } }),
			{ 'claude-code': 'C:\npm\claude' }
		);
		expect(out.paths['claude-code']).toBeNull();
		expect(out.notes[0]).toContain('not a launchable Windows executable');
	});

	it('on Windows accepts a .cmd / .exe pin', () => {
		const out = resolveModelCliPaths(io({ platform: 'win32', files: ['C:\tools\claude.exe'] }), {
			'claude-code': 'C:\tools\claude.exe'
		});
		expect(out.paths['claude-code']).toBe('C:\tools\claude.exe');
	});

	it('disables a pin the file probe rejects (a directory, a missing file)', () => {
		const out = resolveModelCliPaths(io({ platform: 'linux', fileExists: () => false }), {
			codex: '/opt/codex'
		});
		expect(out.paths.codex).toBeNull();
		expect(out.notes[1]).toContain('not an executable file');
	});
});

/**
 * Boot-probe retry — on a busy PC the PATH lookup timed out and the node reported an
 * INSTALLED claude as "not found on PATH". The async probe keeps the two
 * apart: a timed-out lookup is unknown, never missing.
 */
describe('probeModelCliPaths — a timed-out lookup is not "not found" (boot-probe retry)', () => {
	const TIMEOUT_DETAIL =
		'probe timed out: PATH lookup (where claude) did not finish in 4 attempts (deadlines 5 s, 10 s, 20 s, 30 s)';

	function asyncIo(results: Record<string, PathSearchResult>, over: Partial<ModelCliProbeIo> = {}) {
		const searched: string[] = [];
		const value: ModelCliProbeIo = {
			env: {},
			platform: 'win32',
			fileExists: () => false,
			searchPath: async (command) => {
				searched.push(command);
				return results[command] ?? { status: 'not-found' };
			},
			...over
		};
		return { io: value, searched };
	}

	it('reports a timed-out lookup as "probe timed out", with nothing advertised', async () => {
		const { io: probeIo } = asyncIo({
			claude: { status: 'timed-out', detail: TIMEOUT_DETAIL },
			codex: { status: 'not-found' }
		});
		const out = await probeModelCliPaths(probeIo);

		expect(out.paths).toEqual({ 'claude-code': null, codex: null });
		expect(out.timedOut).toEqual(['claude-code']);
		expect(out.notes[0]).toMatch(/^claude-code: probe timed out: PATH lookup \(where claude\)/);
		expect(out.notes[0]).not.toContain('not found on PATH');
		// A real miss still reads exactly as before.
		expect(out.notes[1]).toBe('codex: not found on PATH');
	});

	it('resolves a lookup that answered after its retries exactly like the sync resolver', async () => {
		const { io: probeIo } = asyncIo({
			claude: { status: 'found', hits: ['C:\\npm\\claude', 'C:\\npm\\claude.cmd'] }
		});
		const out = await probeModelCliPaths(probeIo);
		expect(out.paths['claude-code']).toBe('C:\\npm\\claude.cmd');
		expect(out.notes[0]).toBe('claude-code: C:\\npm\\claude.cmd (PATH)');
		expect(out.timedOut).toEqual([]);
	});

	it('never searches PATH for a pinned CLI, and runs the remaining lookups concurrently', async () => {
		let inFlight = 0;
		let peak = 0;
		const searched: string[] = [];
		const out = await probeModelCliPaths({
			env: { [MODEL_CLI_ENV_OVERRIDES.codex]: 'C:\\tools\\codex.exe' },
			platform: 'win32',
			fileExists: (path) => path === 'C:\\tools\\codex.exe',
			searchPath: async (command) => {
				searched.push(command);
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setImmediate(resolve));
				inFlight -= 1;
				return { status: 'not-found' };
			}
		});
		expect(searched).toEqual(['claude']);
		expect(out.paths.codex).toBe('C:\\tools\\codex.exe');

		peak = 0;
		await probeModelCliPaths({
			env: {},
			platform: 'linux',
			fileExists: () => false,
			searchPath: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setImmediate(resolve));
				inFlight -= 1;
				return { status: 'not-found' };
			}
		});
		expect(peak).toBe(2);
	});

	it('keeps the synchronous resolver unchanged: no timeouts it could ever see', () => {
		expect(resolveModelCliPaths(io({ hits: { claude: ['/usr/bin/claude'] } })).timedOut).toEqual([]);
	});
});
