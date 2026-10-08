import { FLEET_MAX_CLI_VERSION_LENGTH, FLEET_MAX_CLI_VERSIONS } from '@ever-works/contracts';
import type { CommandRunner } from './capabilities';
import { MODEL_CLI_OPTIONAL_FLAGS, type ModelCliPaths } from './executors/model-cli';
import { parseCliVersion } from './telemetry-probe';

/**
 * Node lifecycle (self-build slice AR) — what the PINNED model CLIs on this
 * machine actually are, and which of the flags the node passes them they
 * actually understand.
 *
 * ## Why this exists
 *
 * The startup probe (`model-cli-probe.ts`) only proves a binary exists and
 * is launchable. The command builder then emitted `--effort` and
 * `--max-budget-usd` unconditionally, so one upstream CLI release that
 * renamed either broke every run on every PC at once — and only at the
 * model step, after the plan, the lease and the worktree were spent. And
 * the version the heartbeat reported came from scanning PATH for the first
 * of `claude` / `codex` / `gemini` / `opencode`, not from the binary a run
 * spawns, so "which Claude Code does this PC run?" had no reliable answer.
 *
 * ## What it does
 *
 * For each pinned binary: `--version` once (the version), and the help text
 * once (`claude --help`, `codex exec --help` — the subcommand the node
 * drives), from which the advertised `--flags` are read. Both answers are
 * cached per binary PATH + modification time + size, so a beat or a run
 * costs a `stat`, not two process spawns, and an in-place CLI upgrade is
 * re-probed on the very next ask.
 *
 * ## The rule that keeps it honest
 *
 * Help text is parsed, so it can change shape. A help text that does not
 * mention even ONE of the flags the node always passes is treated as
 * UNRECOGNISED (`supportedFlags: null`), never as "supports nothing" — in
 * that state nothing is dropped and the run behaves exactly as it did
 * before this module existed. Guessing would trade a loud failure for a
 * silent downgrade.
 */

export type ModelCliProvider = keyof ModelCliPaths & ('claude-code' | 'codex');

export const MODEL_CLI_PROVIDERS: readonly ModelCliProvider[] = ['claude-code', 'codex'];

/** How each provider is asked for its flags — the subcommand the node actually runs. */
const HELP_ARGS: Readonly<Record<ModelCliProvider, readonly string[]>> = {
	'claude-code': ['--help'],
	codex: ['exec', '--help']
};

/**
 * Flags the command builder passes on EVERY run of that provider. A
 * recognisable help text must list them; one that lists none of them is
 * "unrecognised", one that lists some but not all is INCOMPATIBLE — the
 * next run would fail on the missing one.
 */
export const MODEL_CLI_REQUIRED_FLAGS: Readonly<Record<ModelCliProvider, readonly string[]>> = {
	'claude-code': ['-p', '--output-format', '--permission-mode'],
	codex: ['--json', '--sandbox', '-C']
};

/**
 * Flags passed only on SOME runs — a model override, a multi-repo grant,
 * the MCP bridge, the skip-permissions opt-in. Missing one does not affect
 * every run, so `doctor` reports it separately: "runs that need X will
 * fail here".
 */
export const MODEL_CLI_CONDITIONAL_FLAGS: Readonly<Record<ModelCliProvider, readonly string[]>> = {
	'claude-code': [
		'--model',
		'--add-dir',
		'--mcp-config',
		'--strict-mcp-config',
		'--allowedTools',
		'--dangerously-skip-permissions'
	],
	codex: ['--add-dir', '-c', '-m', '--dangerously-bypass-approvals-and-sandbox']
};

/** What one pinned binary is, and what it understands. */
export interface ModelCliCompatibility {
	provider: ModelCliProvider;
	executable: string;
	/** Parsed from `--version`, or null when it did not answer with one. */
	version: string | null;
	/**
	 * Every flag the help text advertises, or null when the help could not
	 * be read or was not recognisable — in which case NOTHING is dropped.
	 */
	supportedFlags: ReadonlySet<string> | null;
	/** Always-passed flags the help does not list. Non-empty = incompatible. */
	missingRequiredFlags: string[];
	/** Sometimes-passed flags the help does not list. */
	missingConditionalFlags: string[];
	/** Droppable flags the help does not list — runs go ahead without them. */
	unsupportedOptionalFlags: string[];
	/** One line on why the answer is incomplete, or null. */
	note: string | null;
}

/** File identity used as the cache key. */
export interface ModelCliFileStamp {
	mtimeMs: number;
	size: number;
}

export interface ModelCliCompatibilityProbeOptions {
	runner: CommandRunner;
	/** `process.platform`; on Windows a path with spaces is quoted for the shell the runner uses. */
	platform?: string;
	/** File stamp for the cache key; absent or null falls back to a time-boxed cache. */
	statFile?: (path: string) => Promise<ModelCliFileStamp | null> | ModelCliFileStamp | null;
	now?: () => number;
	/** How long an answer is reused when the binary cannot be stamped. Default 10 minutes. */
	unstampedTtlMs?: number;
}

/** Default lifetime of an answer for a binary whose file could not be stamped. */
export const MODEL_CLI_COMPAT_UNSTAMPED_TTL_MS = 10 * 60_000;

interface CacheEntry {
	key: string;
	stamped: boolean;
	probedAt: number;
	result: ModelCliCompatibility;
}

/**
 * Probe, and cache, the compatibility of the pinned model CLIs.
 *
 * Never throws: every failure is folded into the answer (a null version, a
 * null flag set, a note), because a probe runs on the heartbeat and right
 * before a model step, and neither may fail because a binary misbehaved.
 */
export class ModelCliCompatibilityProbe {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inFlight = new Map<string, Promise<ModelCliCompatibility>>();
	private readonly now: () => number;
	private readonly unstampedTtlMs: number;

	constructor(private readonly options: ModelCliCompatibilityProbeOptions) {
		this.now = options.now ?? (() => Date.now());
		this.unstampedTtlMs = options.unstampedTtlMs ?? MODEL_CLI_COMPAT_UNSTAMPED_TTL_MS;
	}

	/** One pinned binary. */
	async probe(provider: ModelCliProvider, executable: string): Promise<ModelCliCompatibility> {
		const stamp = await this.stamp(executable);
		const key = `${provider}|${executable}|${stamp ? `${stamp.mtimeMs}:${stamp.size}` : 'unstamped'}`;
		const cached = this.cache.get(`${provider}|${executable}`);
		if (cached && cached.key === key && (cached.stamped || this.now() - cached.probedAt < this.unstampedTtlMs)) {
			return cached.result;
		}
		const pending = this.inFlight.get(key);
		if (pending) return pending;
		const run = this.run(provider, executable)
			.then((result) => {
				this.cache.set(`${provider}|${executable}`, {
					key,
					stamped: stamp !== null,
					probedAt: this.now(),
					result
				});
				return result;
			})
			.finally(() => {
				this.inFlight.delete(key);
			});
		this.inFlight.set(key, run);
		return run;
	}

	/** Every pinned binary in `paths`, in provider order. Unpinned providers are skipped. */
	async probeAll(paths: ModelCliPaths | null | undefined): Promise<ModelCliCompatibility[]> {
		const out: ModelCliCompatibility[] = [];
		for (const provider of MODEL_CLI_PROVIDERS) {
			const executable = paths?.[provider];
			if (typeof executable !== 'string' || !executable.trim()) continue;
			out.push(await this.probe(provider, executable));
		}
		return out;
	}

	private async stamp(executable: string): Promise<ModelCliFileStamp | null> {
		if (!this.options.statFile) return null;
		try {
			const stamp = await this.options.statFile(executable);
			return stamp && Number.isFinite(stamp.mtimeMs) && Number.isFinite(stamp.size) ? stamp : null;
		} catch {
			return null;
		}
	}

	private async run(provider: ModelCliProvider, executable: string): Promise<ModelCliCompatibility> {
		const command = this.commandFor(executable);
		const version = await this.ask(command, ['--version']).then((output) =>
			output === null ? null : parseCliVersion(output)
		);
		const help = await this.ask(command, [...HELP_ARGS[provider]]);
		return judgeModelCliHelp(provider, executable, version, help);
	}

	/**
	 * The runner on Windows goes through `cmd.exe` (`shell: true`), which
	 * splits an unquoted `C:\Program Files\…` at the space.
	 */
	private commandFor(executable: string): string {
		return this.options.platform === 'win32' && /\s/.test(executable) && !executable.startsWith('"')
			? `"${executable}"`
			: executable;
	}

	/** stdout+stderr of one invocation, or null when it could not be run at all. */
	private async ask(command: string, args: string[]): Promise<string | null> {
		try {
			const result = await this.options.runner.run(command, args);
			const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
			// Help commands commonly exit non-zero on some CLIs; the TEXT is
			// what is judged. A spawn failure with no output is "no answer".
			return result.code === 0 || text.trim() ? text : null;
		} catch {
			return null;
		}
	}
}

/**
 * Every `-x` / `--long-flag` token the help text advertises. Matched as a
 * standalone token (start of line, after whitespace, a comma or a bracket),
 * so `--add-dir` inside `--add-directories` or a URL never counts.
 */
export function parseAdvertisedFlags(help: string): Set<string> {
	const flags = new Set<string>();
	const pattern = /(?:^|[\s,[(|])(--?[A-Za-z][A-Za-z0-9-]*)(?=$|[\s,=<[\])|.:])/gm;
	for (const match of help.matchAll(pattern)) {
		flags.add(match[1]);
	}
	return flags;
}

/**
 * Turn one binary's version + help text into a verdict. Exported so the
 * matrix — recognised, unrecognised, incompatible, a dropped optional flag
 * — is testable from literal help texts without spawning anything.
 */
export function judgeModelCliHelp(
	provider: ModelCliProvider,
	executable: string,
	version: string | null,
	help: string | null
): ModelCliCompatibility {
	const required = MODEL_CLI_REQUIRED_FLAGS[provider];
	const base: ModelCliCompatibility = {
		provider,
		executable,
		version,
		supportedFlags: null,
		missingRequiredFlags: [],
		missingConditionalFlags: [],
		unsupportedOptionalFlags: [],
		note: null
	};
	if (help === null) {
		return { ...base, note: 'the binary did not answer --help; nothing is dropped' };
	}
	const advertised = parseAdvertisedFlags(help);
	if (!required.some((flag) => advertised.has(flag))) {
		return {
			...base,
			note: `the help text lists none of the flags this node always passes (${required.join(', ')}); its format is not recognised, so nothing is dropped`
		};
	}
	const missing = (list: readonly string[]) => list.filter((flag) => !advertised.has(flag));
	return {
		...base,
		supportedFlags: advertised,
		missingRequiredFlags: missing(required),
		missingConditionalFlags: missing(MODEL_CLI_CONDITIONAL_FLAGS[provider]),
		unsupportedOptionalFlags: missing(MODEL_CLI_OPTIONAL_FLAGS[provider])
	};
}

/** True when a run on this binary is expected to work (nothing it always needs is missing). */
export function isModelCliCompatible(compat: ModelCliCompatibility): boolean {
	return compat.missingRequiredFlags.length === 0;
}

/**
 * The heartbeat's `cliVersions`: one `"<provider> <version>"` entry per
 * pinned binary, `"<provider> unknown"` when it did not answer `--version`.
 * Capped to the contract bounds so what the node shows is what Fleet stores.
 */
export function describeCliVersions(results: readonly ModelCliCompatibility[]): string[] {
	return results
		.map((result) => `${result.provider} ${result.version ?? 'unknown'}`.slice(0, FLEET_MAX_CLI_VERSION_LENGTH))
		.slice(0, FLEET_MAX_CLI_VERSIONS);
}

/** The command name the legacy single `cliVersion` field has always used. */
const LEGACY_COMMAND_NAME: Readonly<Record<ModelCliProvider, string>> = {
	'claude-code': 'claude',
	codex: 'codex'
};

/**
 * The legacy single `cliVersion` field, from the PINNED binaries rather than
 * a PATH scan: the first pinned provider that reported a version, in the
 * `"<command> <version>"` shape the field has always had (`claude 2.1.3`),
 * so the runner pill reads exactly as before — only now it is the binary a
 * run would spawn. Null when no pinned binary answered; the caller then
 * falls back to the PATH scan for a visibility-only machine.
 */
export function primaryPinnedCliVersion(results: readonly ModelCliCompatibility[]): string | null {
	const first = results.find((result) => result.version !== null);
	return first
		? `${LEGACY_COMMAND_NAME[first.provider]} ${first.version}`.slice(0, FLEET_MAX_CLI_VERSION_LENGTH)
		: null;
}
