import { describe, expect, it } from 'vitest';
import { join, parse } from 'node:path';
import { buildNodeCheckEnv, NODE_CHECK_ENV_ALLOWLIST } from '../executors/acceptance-checks';
import {
	applyIsolatedHomeEnv,
	applyLocalSessionHomeEnv,
	CLAUDE_HEADLESS_GATE_KEYS,
	claudeConfigRelocationLoss,
	deleteEnvNameAnyCase,
	ISOLATED_HOME_ENV_NAMES,
	ISOLATED_HOME_RESIDUAL_ENV_NAMES,
	isolatedHomeEnv,
	isolatedHomeLayout,
	MODEL_SESSION_HOME_DIR_NAME,
	MODEL_SESSION_HOME_ENV_NAME,
	parseClaudeConfig
} from './isolated-home';

/**
 * The per-run isolated home (self-build slice AK).
 *
 * This module is the ONE implementation of the home redirection, shared
 * by the hardened executor and by the ordinary command runner the model
 * step actually goes through today. Three properties carry the weight:
 *
 *   1. every home ANCHOR is redirected, not just `HOME` — a tool that
 *      reads `%APPDATA%` or `$XDG_CONFIG_HOME` must land inside the run's
 *      own directory too;
 *   2. a prior CASE-SPELLING of any of those names is deleted, not merely
 *      shadowed. Windows env names are case-insensitive and a spawn env is
 *      a plain map, so `{ Temp: <real>, TEMP: <isolated> }` is a redirect
 *      that fails open on the platform the fleet runs on;
 *   3. exactly one directory is mirrored back in — the provider's own
 *      config home — because without it the machine's CLI login is severed
 *      and the node is contained but dead.
 */

const ROOT = process.platform === 'win32' ? 'C:\\scratch\\job-1\\run-home' : '/scratch/job-1/run-home';

describe('isolatedHomeLayout', () => {
	it('puts the home and the temp dir under the run-owned root', () => {
		const layout = isolatedHomeLayout(ROOT);
		expect(layout.root).toBe(ROOT);
		expect(layout.home).toBe(join(ROOT, 'home'));
		expect(layout.temp).toBe(join(ROOT, 'tmp'));
	});

	it('names every directory that has to exist before a CLI is spawned', () => {
		const layout = isolatedHomeLayout(ROOT);
		expect([...layout.directories]).toEqual([
			join(ROOT, 'tmp'),
			join(ROOT, 'home', 'AppData', 'Roaming'),
			join(ROOT, 'home', 'AppData', 'Local'),
			join(ROOT, 'home', '.cache'),
			join(ROOT, 'home', '.config'),
			join(ROOT, 'home', '.local', 'share'),
			join(ROOT, 'home', '.local', 'state')
		]);
	});
});

describe('isolatedHomeEnv', () => {
	const layout = isolatedHomeLayout(ROOT);
	const env = isolatedHomeEnv(layout);

	it('redirects every anchor it claims to redirect', () => {
		// The exported list IS the contract; a name added to one and not the
		// other is the drift this assertion exists to catch.
		expect(Object.keys(env).sort()).toEqual([...ISOLATED_HOME_ENV_NAMES].sort());
	});

	it('points the POSIX and Windows anchors at the run-owned home', () => {
		expect(env.HOME).toBe(layout.home);
		expect(env.USERPROFILE).toBe(layout.home);
		expect(env.APPDATA).toBe(join(layout.home, 'AppData', 'Roaming'));
		expect(env.LOCALAPPDATA).toBe(join(layout.home, 'AppData', 'Local'));
		expect(env.XDG_CACHE_HOME).toBe(join(layout.home, '.cache'));
		expect(env.XDG_CONFIG_HOME).toBe(join(layout.home, '.config'));
		expect(env.XDG_DATA_HOME).toBe(join(layout.home, '.local', 'share'));
		expect(env.XDG_STATE_HOME).toBe(join(layout.home, '.local', 'state'));
		expect(env.TEMP).toBe(layout.temp);
		expect(env.TMP).toBe(layout.temp);
		expect(env.TMPDIR).toBe(layout.temp);
	});

	it('splits HOMEDRIVE / HOMEPATH so `%HOMEDRIVE%%HOMEPATH%` rejoins to the same home', () => {
		expect(`${env.HOMEDRIVE}${env.HOMEPATH}`).toBe(layout.home);
		expect(env.HOMEDRIVE).toBe(/^([A-Za-z]:)[\\/]/u.exec(parse(layout.home).root)?.[1] ?? '');
	});

	/**
	 * The rejoin has to hold for EVERY root shape, not just `C:\`.
	 * `scratchRoot` is operator-configurable (`runtime.ts`,
	 * `options.agentTaskScratchRoot`), so a UNC share reaches this; and a
	 * POSIX root reaches it on every non-Windows run of this very suite.
	 * Putting a non-drive root in `HOMEDRIVE` while leaving `HOMEPATH`
	 * absolute concatenates to a path that does not exist.
	 */
	it.each([
		['a UNC share', '\\\\build-store\\fleet\\run-home'],
		['a POSIX root', '/srv/fleet/run-home'],
		['a drive letter', 'D:\\fleet\\run-home']
	])('rejoins for %s', (_label, root) => {
		const other = isolatedHomeLayout(root);
		const built = isolatedHomeEnv(other);
		expect(`${built.HOMEDRIVE}${built.HOMEPATH}`).toBe(other.home);
	});
});

describe('ISOLATED_HOME_RESIDUAL_ENV_NAMES — the disclosed residual cannot drift', () => {
	it('names anchors the command runner really does forward, and really does not redirect', () => {
		for (const name of ISOLATED_HOME_RESIDUAL_ENV_NAMES) {
			// On the allowlist: it genuinely reaches the model step...
			expect(NODE_CHECK_ENV_ALLOWLIST).toContain(name);
			// ...and not redirected, so it genuinely still names the real home.
			expect(ISOLATED_HOME_ENV_NAMES).not.toContain(name);
		}
	});

	it('is what a realistic Windows parent env actually leaks through the overlay', () => {
		const REAL = 'C:\\Users\\owner';
		const parent: NodeJS.ProcessEnv = {
			Path: 'C:\\Windows\\System32',
			USERPROFILE: REAL,
			APPDATA: `${REAL}\\AppData\\Roaming`,
			LOCALAPPDATA: `${REAL}\\AppData\\Local`,
			TEMP: `${REAL}\\AppData\\Local\\Temp`,
			PNPM_HOME: `${REAL}\\AppData\\Local\\pnpm`,
			COREPACK_HOME: `${REAL}\\AppData\\Local\\node\\corepack`,
			NVM_DIR: `${REAL}\\AppData\\Roaming\\nvm`,
			VOLTA_HOME: `${REAL}\\.volta`,
			CARGO_HOME: `${REAL}\\.cargo`,
			RUSTUP_HOME: `${REAL}\\.rustup`,
			GOPATH: `${REAL}\\go`,
			PYENV_ROOT: `${REAL}\\.pyenv`,
			BUN_INSTALL: `${REAL}\\.bun`,
			DOTNET_ROOT: `${REAL}\\.dotnet`,
			NODE_OPTIONS: `--require ${REAL}\\hook.js`
		};
		const overlay = applyLocalSessionHomeEnv(
			applyIsolatedHomeEnv({} as Record<string, string>, isolatedHomeLayout('C:\\scratch\\job-1\\run-home')),
			'claude-code',
			`${REAL}\\.claude`
		);
		const env = buildNodeCheckEnv(undefined, parent, undefined, overlay);
		const leaking = Object.keys(env)
			.filter((name) => env[name]!.includes(REAL) && name !== 'CLAUDE_CONFIG_DIR')
			.sort();

		// EVERY survivor is disclosed. This is the assertion that makes the
		// standing `toolchain-anchors` downgrade a measured statement rather
		// than a guess, and it goes red the day the allowlist grows a name
		// the residual list does not mention.
		expect(leaking.filter((name) => !ISOLATED_HOME_RESIDUAL_ENV_NAMES.includes(name))).toEqual([]);
		// ...and it is not vacuous: the parent really does carry them.
		expect(leaking).toContain('PNPM_HOME');
		expect(leaking).toContain('NODE_OPTIONS');
	});
});

/**
 * `CLAUDE_CONFIG_DIR` is a RELOCATION (review F1).
 *
 * Setting it moves Claude Code's top-level config from `~/.claude.json` to
 * `<dir>/.claude.json` — a different file. On a machine whose onboarding
 * lives in the first one, the relocated config presents to `claude -p` as
 * never onboarded, and a `-p` run cannot answer the prompt that gates.
 * This is the probe that lets the caller decline to isolate rather than
 * ship that.
 */
describe('claudeConfigRelocationLoss', () => {
	it('names the gates the machine passes today and would stop passing', () => {
		expect(claudeConfigRelocationLoss({ hasCompletedOnboarding: true }, { machineID: 'abc' })).toEqual([
			'hasCompletedOnboarding'
		]);
	});

	it('reports nothing when the relocated config already carries them', () => {
		const live = { hasCompletedOnboarding: true, hasTrustDialogHooksAccepted: true };
		expect(claudeConfigRelocationLoss(live, { ...live, machineID: 'abc' })).toEqual([]);
	});

	it('reports nothing for a gate the machine does not pass either way', () => {
		// Not this control's problem, and not this control's to claim: a run
		// gated before the redirect is gated after it for the same reason.
		expect(claudeConfigRelocationLoss({ hasCompletedOnboarding: true }, { hasCompletedOnboarding: true })).toEqual(
			[]
		);
		expect(claudeConfigRelocationLoss({}, {})).toEqual([]);
	});

	it('reports nothing when the machine has no top-level config at all', () => {
		expect(claudeConfigRelocationLoss(null, null)).toEqual([]);
	});

	it('covers every key the claude-code plugin seeds as a headless gate', () => {
		// `packages/plugins/claude-code/src/utils/workspace-manager.ts`
		// writes these before every spawn that pins `CLAUDE_CONFIG_DIR`.
		expect([...CLAUDE_HEADLESS_GATE_KEYS].sort()).toEqual([
			'bypassPermissionsModeAccepted',
			'hasCompletedOnboarding',
			'hasTrustDialogHooksAccepted'
		]);
		const live = Object.fromEntries(CLAUDE_HEADLESS_GATE_KEYS.map((key) => [key, true]));
		expect(claudeConfigRelocationLoss(live, null)).toEqual([...CLAUDE_HEADLESS_GATE_KEYS]);
	});
});

describe('parseClaudeConfig', () => {
	it('reads an object and refuses everything else', () => {
		expect(parseClaudeConfig('{"hasCompletedOnboarding":true}')).toEqual({ hasCompletedOnboarding: true });
		expect(parseClaudeConfig(null)).toBeNull();
		expect(parseClaudeConfig('')).toBeNull();
		expect(parseClaudeConfig('not json')).toBeNull();
		expect(parseClaudeConfig('[1,2]')).toBeNull();
		expect(parseClaudeConfig('"a string"')).toBeNull();
	});
});

describe('applyIsolatedHomeEnv — the redirect cannot fail open on a case-spelling', () => {
	it('deletes every prior spelling of every anchor before setting its own', () => {
		const layout = isolatedHomeLayout(ROOT);
		// Exactly the shape the ordinary runner's allowlist produces on
		// Windows: names copied through with the PARENT's spelling.
		const env = applyIsolatedHomeEnv(
			{
				Path: 'C:\\Windows\\System32',
				Temp: 'C:\\Users\\owner\\AppData\\Local\\Temp',
				UserProfile: 'C:\\Users\\owner',
				HomePath: '\\Users\\owner',
				AppData: 'C:\\Users\\owner\\AppData\\Roaming',
				home: '/home/owner'
			},
			layout
		);

		// Not one spelling of a redirected anchor still names the real home.
		const survivors = Object.entries(env).filter(([, value]) => value.includes('owner'));
		expect(survivors).toEqual([]);
		// Exactly one key per anchor, in the canonical spelling.
		for (const name of ISOLATED_HOME_ENV_NAMES) {
			const keys = Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());
			expect(keys).toEqual([name]);
		}
		// Untouched names are left exactly as they were.
		expect(env.Path).toBe('C:\\Windows\\System32');
	});

	it('returns the same object it was handed, so callers cannot lose the redirect', () => {
		const env: Record<string, string> = {};
		expect(applyIsolatedHomeEnv(env, isolatedHomeLayout(ROOT))).toBe(env);
	});
});

describe('deleteEnvNameAnyCase', () => {
	it('removes the name whatever the casing, and nothing else', () => {
		const env: Record<string, string> = { TEMP: 'a', Temp: 'b', tEmP: 'c', TEMPO: 'keep' };
		deleteEnvNameAnyCase(env, 'temp');
		expect(env).toEqual({ TEMPO: 'keep' });
	});
});

describe('applyLocalSessionHomeEnv — the one deliberate hole', () => {
	it('points Claude Code at the real session home and Codex at its own', () => {
		expect(MODEL_SESSION_HOME_ENV_NAME['claude-code']).toBe('CLAUDE_CONFIG_DIR');
		expect(MODEL_SESSION_HOME_ENV_NAME.codex).toBe('CODEX_HOME');
		expect(MODEL_SESSION_HOME_DIR_NAME['claude-code']).toBe('.claude');
		expect(MODEL_SESSION_HOME_DIR_NAME.codex).toBe('.codex');

		expect(applyLocalSessionHomeEnv({}, 'claude-code', '/home/owner/.claude')).toEqual({
			CLAUDE_CONFIG_DIR: '/home/owner/.claude'
		});
		expect(applyLocalSessionHomeEnv({}, 'codex', '/home/owner/.codex')).toEqual({
			CODEX_HOME: '/home/owner/.codex'
		});
	});

	it('deletes a prior case-spelling rather than leaving two config dirs in play', () => {
		const env = applyLocalSessionHomeEnv(
			{ Claude_Config_Dir: 'C:\\somewhere\\else' },
			'claude-code',
			'C:\\Users\\owner\\.claude'
		);
		expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'C:\\Users\\owner\\.claude' });
	});

	it('survives the home redirect — it is applied over it, never under it', () => {
		const layout = isolatedHomeLayout(ROOT);
		const env = applyLocalSessionHomeEnv(
			applyIsolatedHomeEnv({} as Record<string, string>, layout),
			'claude-code',
			'/home/owner/.claude'
		);
		// The CLI still finds its login...
		expect(env.CLAUDE_CONFIG_DIR).toBe('/home/owner/.claude');
		// ...and everything else still lands in the run's own directory.
		expect(env.HOME).toBe(layout.home);
		expect(env.APPDATA?.startsWith(layout.home)).toBe(true);
	});
});
