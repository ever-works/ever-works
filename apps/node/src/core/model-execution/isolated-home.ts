import { join, parse } from 'node:path';

/**
 * The per-run ISOLATED HOME — the one piece of the hardened executor that
 * is pure environment construction (self-build slice AK).
 *
 * ## Why this module exists
 *
 * `model-execution/` is the hardened executor. It fails closed without a
 * signed Windows Job-Object helper, so it has no production callers and
 * will not until an external signing identity and a release lane exist.
 * Meanwhile the model step a fleet node actually runs goes through the
 * ORDINARY command runner (`executors/acceptance-checks.ts`), whose env
 * scrub deliberately KEEPS and back-fills `HOME` / `USERPROFILE` /
 * `APPDATA` — because a check needs a home directory to resolve a
 * toolchain from.
 *
 * The isolated home has no dependency on the helper: it is a dozen
 * environment names pointed at a directory this run owns. Lifting it out
 * of the hardened path is therefore the containment that can ship today.
 *
 * ## Why extracted rather than called through `buildModelEnvironment`
 *
 * The hardened path's environment builder is not separable from its
 * hardened ALLOWLIST (`SAFE_SYSTEM_ENV_NAMES` — no `NVM_DIR`, no
 * `PNPM_HOME`, no `JAVA_HOME`), and that allowlist is correct for a
 * single `claude -p` invocation and wrong for the ordinary runner, which
 * also has to run `pnpm install` and `pnpm test`. Forcing the ordinary
 * runner through it would break every real acceptance check. The unit
 * that is genuinely shareable is exactly this: the home redirection, and
 * the layout on disk it needs. Both paths now build it from here, so a
 * name added to one is added to both.
 *
 * ## What this DOES and DOES NOT deny
 *
 * DOES: every tool that resolves its configuration THROUGH the home
 * anchors — `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.gitconfig` and the git
 * credential store it names, `~/.config/gh`, and every `~` expansion —
 * now resolves inside an empty directory this run owns and that is
 * deleted when the run ends.
 *
 * The provider's OWN config home is the single deliberate exception and
 * is NOT in that list: it is mirrored back in, read AND write, by
 * {@link MODEL_SESSION_HOME_ENV_NAME}. `~/.claude/.credentials.json` is
 * therefore still reachable, on purpose. Read that block before quoting
 * this one — a summary that claimed the CLI credential was denied would
 * be the exact over-report this slice exists to prevent.
 *
 * DOES NOT: stop a deliberate absolute-path read. This is an ENVIRONMENT
 * control, not a filesystem boundary; `type C:\Users\me\.ssh\id_ed25519`
 * still works. What changes is the DEFAULT: a prompt injection no longer
 * gets the machine's credentials from tools that were going to hand them
 * over on their own. The filesystem boundary is the Job Object, and that
 * is what the signed helper is for.
 *
 * DOES NOT: redirect the toolchain anchors the ordinary runner's
 * allowlist forwards as absolute paths — `PNPM_HOME`, `NVM_DIR`,
 * `CARGO_HOME`, `GOPATH`, `NODE_OPTIONS` and the rest of
 * {@link ISOLATED_HOME_RESIDUAL_ENV_NAMES}. They keep naming the real
 * profile, and a run says so: the node reports a standing
 * `toolchain-anchors` downgrade on every job rather than letting
 * `isolatedHome: true` read as "nothing of the real home is left".
 *
 * ## A decision this REVERSES, deliberately
 *
 * `packages/plugins/claude-code/src/utils/subprocess-env.ts` keeps
 * `APPDATA` / `LOCALAPPDATA` pointed at the real profile even when it
 * isolates the home, because "Node and the package managers the agent
 * shells out to read their own machine config from there, and breaking
 * that would fail runs rather than harden them" — and it excuses the
 * residual on the grounds that "the deployed runner is Linux, where these
 * are unset". A fleet node is precisely the Windows case that reasoning
 * excluded, so the trade is not the same one:
 *
 *   - this overlay applies to the MODEL step only. The package managers
 *     run in the SETUP phase and the acceptance checks, and those keep the
 *     machine's real `APPDATA` / `LOCALAPPDATA` exactly as before;
 *   - on Windows `%APPDATA%\npm` is where an npm token lives, so leaving
 *     it pointed at the real profile on the one step that takes an
 *     untrusted prompt is the hole the slice exists to close.
 *
 * The cost is real and is not hidden: inside the model step `npm` / `npx`
 * get a cold cache, `~/.npmrc` is gone, and `git` has no `user.email` or
 * `credential.helper`, so a model that runs `git commit` itself fails with
 * "Author identity unknown". The node's own finalizer does the commit and
 * the push OUTSIDE this overlay, so the product path is unaffected.
 */

/** Where a run's isolated home lives, and what has to exist on disk first. */
export interface IsolatedHomeLayout {
	/** The run-owned root both directories live under. */
	readonly root: string;
	/** Value for `HOME` / `USERPROFILE`. */
	readonly home: string;
	/** Value for `TEMP` / `TMP` / `TMPDIR`. */
	readonly temp: string;
	/**
	 * Every directory that must exist before the child is spawned.
	 *
	 * A CLI that finds `%APPDATA%` pointing at a path that is not there
	 * does not always fall back gracefully — some write, some throw, and
	 * which one is a detail of a binary this node does not own. Creating
	 * them is cheaper than finding out per provider.
	 */
	readonly directories: readonly string[];
}

/** The layout for one run, rooted at a directory that run exclusively owns. */
export function isolatedHomeLayout(runRoot: string): IsolatedHomeLayout {
	const home = join(runRoot, 'home');
	const temp = join(runRoot, 'tmp');
	return {
		root: runRoot,
		home,
		temp,
		directories: [
			temp,
			join(home, 'AppData', 'Roaming'),
			join(home, 'AppData', 'Local'),
			join(home, '.cache'),
			join(home, '.config'),
			join(home, '.local', 'share'),
			join(home, '.local', 'state')
		]
	};
}

/**
 * Every environment name the isolated home takes over.
 *
 * Exported so a test can assert the set rather than re-listing it, and so
 * a reviewer can see in one place exactly which anchors are redirected.
 * Both platforms' spellings are here on purpose: a fleet node is a
 * Windows PC today, and a name that is inert on one platform costs
 * nothing while a MISSING name is a hole on the other.
 */
export const ISOLATED_HOME_ENV_NAMES: readonly string[] = [
	'HOME',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'TEMP',
	'TMP',
	'TMPDIR'
];

/**
 * Every anchor the ordinary runner's allowlist still forwards as an
 * ABSOLUTE path into the machine's real profile, even with the isolated
 * home applied.
 *
 * Dropping them is not the right trade — they are how a node resolves its
 * own toolchain, and an absolute read works whether or not the variable is
 * present — so they are DISCLOSED instead: this list is the source of the
 * standing `toolchain-anchors` downgrade the node reports on every run.
 *
 * Kept honest by a test that asserts every name here is on
 * `NODE_CHECK_ENV_ALLOWLIST` and on none of {@link ISOLATED_HOME_ENV_NAMES},
 * so the list cannot quietly drift away from what the allowlist does.
 */
export const ISOLATED_HOME_RESIDUAL_ENV_NAMES: readonly string[] = [
	'NODE_OPTIONS',
	'NODE_EXTRA_CA_CERTS',
	'NVM_DIR',
	'NVM_BIN',
	'VOLTA_HOME',
	'COREPACK_HOME',
	'PNPM_HOME',
	'BUN_INSTALL',
	'JAVA_HOME',
	'GOPATH',
	'GOROOT',
	'CARGO_HOME',
	'RUSTUP_HOME',
	'DOTNET_ROOT',
	'VIRTUAL_ENV',
	'PYENV_ROOT',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'REQUESTS_CA_BUNDLE',
	'CURL_CA_BUNDLE'
];

/** The name → value map an isolated home imposes. Pure; touches nothing. */
export function isolatedHomeEnv(layout: IsolatedHomeLayout): Record<string, string> {
	const homeRoot = parse(layout.home).root;
	const windowsDrive = /^([A-Za-z]:)[\\/]/u.exec(homeRoot)?.[1];
	return {
		HOME: layout.home,
		USERPROFILE: layout.home,
		// `%HOMEDRIVE%%HOMEPATH%` MUST rejoin to `layout.home`, and only a
		// drive-lettered root can carry a non-empty `HOMEDRIVE` and still do
		// that. A POSIX root (`/`) or a UNC one (`\\server\share\`) is part
		// of the path itself, so putting it in `HOMEDRIVE` while leaving
		// `HOMEPATH` absolute concatenates to a path that does not exist —
		// which is reachable here, because `scratchRoot` is operator
		// configurable (`runtime.ts`, `options.agentTaskScratchRoot`) and can
		// be a UNC share. Empty `HOMEDRIVE` + absolute `HOMEPATH` rejoins on
		// every root shape.
		HOMEDRIVE: windowsDrive ?? '',
		HOMEPATH: windowsDrive ? layout.home.slice(windowsDrive.length) : layout.home,
		APPDATA: join(layout.home, 'AppData', 'Roaming'),
		LOCALAPPDATA: join(layout.home, 'AppData', 'Local'),
		XDG_CACHE_HOME: join(layout.home, '.cache'),
		XDG_CONFIG_HOME: join(layout.home, '.config'),
		XDG_DATA_HOME: join(layout.home, '.local', 'share'),
		XDG_STATE_HOME: join(layout.home, '.local', 'state'),
		TEMP: layout.temp,
		TMP: layout.temp,
		TMPDIR: layout.temp
	};
}

/**
 * Remove EVERY case-spelling of `name` from a built environment map.
 *
 * Windows environment names are case-insensitive but a spawn environment
 * is a plain map, so `{ Temp: <real>, TEMP: <isolated> }` is two entries
 * and which one the child sees is the platform's business, not ours. A
 * redirect that leaves the original spelling behind is a redirect that
 * fails open, which is the one outcome this whole module exists to
 * prevent — so every setter here deletes first.
 */
export function deleteEnvNameAnyCase(env: Record<string, string>, name: string): void {
	const upper = name.toUpperCase();
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === upper) delete env[key];
	}
}

/** Apply {@link isolatedHomeEnv} over a built environment, deleting every prior spelling. */
export function applyIsolatedHomeEnv<T extends Record<string, string>>(env: T, layout: IsolatedHomeLayout): T {
	for (const name of ISOLATED_HOME_ENV_NAMES) deleteEnvNameAnyCase(env, name);
	Object.assign(env, isolatedHomeEnv(layout));
	return env;
}

/** The two local model CLIs a fleet node knows how to drive. */
export type IsolatedHomeProvider = 'claude-code' | 'codex';

/**
 * THE deliberate hole in the isolated home, one name per provider.
 *
 * A naive lift of the isolated home severs the machine's CLI login: both
 * CLIs keep their session credential under the real home
 * (`~/.claude/.credentials.json`, `~/.codex/auth.json`), and a run that
 * cannot authenticate is not a contained run, it is a dead node. Both
 * CLIs also accept an explicit override for where that directory is, and
 * pointing it back at the REAL one is what keeps the login while
 * everything else stays redirected.
 *
 * So the trade-off, stated plainly:
 *
 *   DENIED  — the whole of the real home: `~/.ssh`, `~/.aws`, `~/.npmrc`,
 *             `~/.gitconfig` and its credential helper, `~/.config/gh`,
 *             every other repository's cached credentials, and every `~`
 *             a tool expands on its own.
 *   MIRRORED — exactly one directory, the provider's own config home,
 *             named here and nowhere else. That is what the run is
 *             SUPPOSED to use: it is the identity the node was enrolled
 *             with, and the whole reason this machine can run agent work.
 *   COST    — that directory is READ-WRITE, not merely readable, and
 *             nothing here makes it otherwise. So a prompt injection can
 *             read this node's own CLI credential, and it can also WRITE:
 *             `settings.json`, a hook, an MCP server definition. Those
 *             outlive the run — the scratch deletion does not reach this
 *             directory — and they are the machine owner's own
 *             interactive config. "The file tools are scoped to cwd" is
 *             not an answer by this codebase's own standard; `model-cli.ts`
 *             says of a `permissions.deny` rule that it "is not a
 *             containment boundary and is not pretended to be one",
 *             because a shell redirect ignores it. Narrowing this needs a
 *             filesystem boundary (the Job Object) or a token broker, not
 *             an environment variable. The reporting channel is already
 *             closed: the value is scrubbed out of the summary and output
 *             tail by `parseModelCliResult`.
 *
 * This mirrors `ModelCliCommand.localSessionHome` in the hardened path,
 * which resolves the same directory and feeds it to the same two names.
 *
 * ## `CLAUDE_CONFIG_DIR` is a RELOCATION, not a pointer at what is there
 *
 * Setting it does not merely tell Claude Code where the credential lives;
 * it moves the CLI's whole top-level config to
 * `<dir>/.claude.json`, which with the variable UNSET is `~/.claude.json`
 * — a DIFFERENT file from `~/.claude/.claude.json`. This repo already
 * depends on that: `packages/plugins/claude-code` seeds
 * `<configDir>/.claude.json` with `hasCompletedOnboarding` /
 * `bypassPermissionsModeAccepted` / `hasTrustDialogHooksAccepted`
 * (`utils/workspace-manager.ts`) BEFORE every spawn that pins
 * `CLAUDE_CONFIG_DIR`, precisely because an unseeded one gates a headless
 * run — and a `-p` run has no way to answer an onboarding prompt.
 *
 * The fleet node cannot seed that file: it belongs to the machine owner,
 * not to the run. So it does the other safe thing —
 * {@link claudeConfigRelocationLoss} reads both files and reports which
 * gates the relocation would LOSE, and the caller declines to isolate
 * when there are any, recording the reason on the job row. An isolated
 * home is not worth a node that fails every model step.
 */
export const MODEL_SESSION_HOME_ENV_NAME: Readonly<Record<IsolatedHomeProvider, string>> = {
	'claude-code': 'CLAUDE_CONFIG_DIR',
	codex: 'CODEX_HOME'
};

/** The conventional directory name each CLI keeps its session under, inside the real home. */
export const MODEL_SESSION_HOME_DIR_NAME: Readonly<Record<IsolatedHomeProvider, string>> = {
	'claude-code': '.claude',
	codex: '.codex'
};

/**
 * Point the provider's config home at `sessionHome`, deleting every prior
 * spelling first for the same reason {@link deleteEnvNameAnyCase} exists.
 */
export function applyLocalSessionHomeEnv<T extends Record<string, string>>(
	env: T,
	provider: IsolatedHomeProvider,
	sessionHome: string
): T {
	const name = MODEL_SESSION_HOME_ENV_NAME[provider];
	deleteEnvNameAnyCase(env, name);
	(env as Record<string, string>)[name] = sessionHome;
	return env;
}

/** Claude Code's top-level config file, resolved from `CLAUDE_CONFIG_DIR` when that is set. */
export const CLAUDE_TOP_LEVEL_CONFIG_FILE_NAME = '.claude.json';

/**
 * The top-level flags in that file which, when missing, gate a headless
 * `claude -p` run.
 *
 * Taken from `packages/plugins/claude-code/src/utils/workspace-manager.ts`
 * (`HEADLESS_CONFIG`), which writes exactly these before every spawn that
 * pins `CLAUDE_CONFIG_DIR`. `autoUpdates` is in that set too and is left
 * out here: it is a preference, not a gate, and a run does not fail for
 * want of it.
 */
export const CLAUDE_HEADLESS_GATE_KEYS: readonly string[] = [
	'hasCompletedOnboarding',
	'bypassPermissionsModeAccepted',
	'hasTrustDialogHooksAccepted'
];

/**
 * Which headless gates the machine currently satisfies but would STOP
 * satisfying once `CLAUDE_CONFIG_DIR` relocates the top-level config.
 *
 * Both arguments are the parsed contents of a `.claude.json`, or null when
 * the file is absent or unreadable:
 *
 *   - `live` — what the CLI reads today, with the variable unset:
 *     `<real home>/.claude.json`.
 *   - `relocated` — what it would read instead:
 *     `<CLAUDE_CONFIG_DIR>/.claude.json`.
 *
 * Only a gate the machine ALREADY passes can be lost, so a flag that is
 * absent from both is not reported: the relocation did not change it, and
 * a run that would have been gated before is gated for reasons this
 * control neither caused nor can fix. Returned as NAMES only — the file
 * also holds the owner's project history, and none of it is read, logged
 * or reported.
 */
export function claudeConfigRelocationLoss(
	live: Record<string, unknown> | null,
	relocated: Record<string, unknown> | null
): string[] {
	if (!live) return [];
	return CLAUDE_HEADLESS_GATE_KEYS.filter((key) => live[key] === true && relocated?.[key] !== true);
}

/** Parse a `.claude.json` body, or null for anything that is not a JSON object. */
export function parseClaudeConfig(raw: string | null): Record<string, unknown> | null {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
