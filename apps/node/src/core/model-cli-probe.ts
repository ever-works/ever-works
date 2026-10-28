import type { ModelCliPaths } from './executors/model-cli';

/**
 * Resolve the model CLIs this node may drive — once, at startup.
 *
 * Precedence per CLI:
 *   1. an explicit operator path (`EVER_WORKS_NODE_CLAUDE_PATH` /
 *      `EVER_WORKS_NODE_CODEX_PATH`, or the matching `--…-path` flag);
 *      a path that does not resolve to an executable DISABLES the CLI
 *      rather than falling through to PATH — silently running a
 *      different binary than the one an operator pinned is how a run
 *      succeeds for the wrong reason;
 *   2. the first `claude` / `codex` on PATH.
 *
 * Resolved paths become both the executable the `agent-task` model step
 * spawns AND the `claude-code` / `codex` capability tags the node
 * advertises, so the tag and the executor can never disagree about what
 * is installed (the same rule `browser` follows).
 */
export interface ModelCliProbeIo {
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform | string;
	/** True when the path is an existing REGULAR FILE this process may execute (never a directory). */
	fileExists(path: string): boolean;
	/** Every PATH hit for a bare command, first match first; `[]` when none. */
	lookupAllOnPath?(command: string): string[];
	/** Single-hit variant kept for callers that only have `which`. */
	lookupOnPath?(command: string): string | null;
	/**
	 * The PATH lookup that can tell "timed out" from "not there" (boot-probe retry),
	 * used by {@link probeModelCliPaths}. Absent, the probe falls back to the
	 * synchronous lookups above, which cannot.
	 */
	searchPath?(command: string): Promise<PathSearchResult>;
}

/**
 * One PATH lookup's answer. `timed-out` is NOT a negative: the lookup never
 * finished (a busy machine), so whether the CLI is installed is unknown.
 */
export type PathSearchResult =
	| { status: 'found'; hits: string[] }
	| { status: 'not-found' }
	| { status: 'timed-out'; detail: string };

export const MODEL_CLI_ENV_OVERRIDES = {
	'claude-code': 'EVER_WORKS_NODE_CLAUDE_PATH',
	codex: 'EVER_WORKS_NODE_CODEX_PATH'
} as const;

const MODEL_CLI_COMMANDS = {
	'claude-code': 'claude',
	codex: 'codex'
} as const;

type ModelCliProbeProvider = keyof typeof MODEL_CLI_COMMANDS;

/** Windows launches `.cmd` / `.exe` shims; the extension-less npm shim is a bash script. */
const WINDOWS_LAUNCHABLE = /\.(cmd|exe|bat)$/i;

export interface ModelCliProbeResult {
	paths: ModelCliPaths;
	/** One line per CLI explaining what was chosen (or why not), for the startup log. */
	notes: string[];
	/**
	 * Providers whose PATH lookup TIMED OUT on every attempt (boot-probe retry): unknown,
	 * not missing. Their path is null — nothing unproven is spawned or
	 * advertised — but they are reported as "probe timed out", never as
	 * "not found on PATH".
	 */
	timedOut: ModelCliProbeProvider[];
}

type Overrides = Partial<Record<ModelCliProbeProvider, string | null | undefined>>;

export function resolveModelCliPaths(io: ModelCliProbeIo, overrides: Overrides = {}): ModelCliProbeResult {
	return assemble(io, overrides, (provider) => {
		const hits = lookupHits(io, MODEL_CLI_COMMANDS[provider]);
		return hits.length > 0 ? { status: 'found', hits } : { status: 'not-found' };
	});
}

/**
 * {@link resolveModelCliPaths} through `io.searchPath` (boot-probe retry): the PATH
 * lookups run concurrently, each retried by the IO while it times out, and
 * a lookup that timed out on every attempt is reported as timed out. Pins
 * are decided exactly as in the synchronous resolver.
 */
export async function probeModelCliPaths(io: ModelCliProbeIo, overrides: Overrides = {}): Promise<ModelCliProbeResult> {
	const providers = Object.keys(MODEL_CLI_COMMANDS) as ModelCliProbeProvider[];
	const searches = new Map<ModelCliProbeProvider, PathSearchResult>();
	await Promise.all(
		providers
			.filter((provider) => !pinnedPath(io, overrides, provider))
			.map(async (provider) => {
				const command = MODEL_CLI_COMMANDS[provider];
				let result: PathSearchResult;
				try {
					result = io.searchPath ? await io.searchPath(command) : syncSearch(io, command);
				} catch {
					// A lookup that could not run at all reads as before: not found.
					result = { status: 'not-found' };
				}
				searches.set(provider, result);
			})
	);
	return assemble(io, overrides, (provider) => searches.get(provider) ?? { status: 'not-found' });
}

function assemble(
	io: ModelCliProbeIo,
	overrides: Overrides,
	search: (provider: ModelCliProbeProvider) => PathSearchResult
): ModelCliProbeResult {
	const paths: ModelCliPaths = {};
	const notes: string[] = [];
	const timedOut: ModelCliProbeProvider[] = [];
	for (const provider of Object.keys(MODEL_CLI_COMMANDS) as ModelCliProbeProvider[]) {
		const pinned = pinnedPath(io, overrides, provider);
		if (pinned) {
			// A pin is held to the SAME launchability rule as a PATH hit: it
			// must be a regular executable file, and on Windows a form
			// `cmd.exe` can actually start (`.cmd` / `.exe` / `.bat`, never
			// the extension-less npm shim or a directory). Otherwise the node
			// would advertise a CLI every job on it then fails to spawn.
			if (!io.fileExists(pinned)) {
				paths[provider] = null;
				notes.push(
					`${provider}: disabled — pinned path does not exist or is not an executable file: ${pinned}`
				);
			} else if (io.platform === 'win32' && !WINDOWS_LAUNCHABLE.test(pinned)) {
				paths[provider] = null;
				notes.push(
					`${provider}: disabled — pinned path is not a launchable Windows executable (.cmd/.exe/.bat): ${pinned}`
				);
			} else {
				paths[provider] = pinned;
				notes.push(`${provider}: ${pinned} (pinned)`);
			}
			continue;
		}
		const result = search(provider);
		if (result.status === 'timed-out') {
			// Unknown, not missing: nothing unproven is advertised or spawned,
			// and the operator is told the machine was too busy to say.
			paths[provider] = null;
			timedOut.push(provider);
			notes.push(
				`${provider}: ${result.detail} — not advertised by this process; restart the node once the machine is less busy`
			);
			continue;
		}
		const found = result.status === 'found' ? pickLaunchable(io, result.hits) : null;
		paths[provider] = found;
		notes.push(found ? `${provider}: ${found} (PATH)` : `${provider}: not found on PATH`);
	}
	return { paths, notes, timedOut };
}

function pinnedPath(io: ModelCliProbeIo, overrides: Overrides, provider: ModelCliProbeProvider): string {
	return (overrides[provider] ?? io.env[MODEL_CLI_ENV_OVERRIDES[provider]] ?? '').trim();
}

function lookupHits(io: ModelCliProbeIo, command: string): string[] {
	return io.lookupAllOnPath
		? io.lookupAllOnPath(command)
		: io.lookupOnPath
			? [io.lookupOnPath(command)].filter((hit): hit is string => typeof hit === 'string' && hit.length > 0)
			: [];
}

function syncSearch(io: ModelCliProbeIo, command: string): PathSearchResult {
	const hits = lookupHits(io, command);
	return hits.length > 0 ? { status: 'found', hits } : { status: 'not-found' };
}

function pickLaunchable(io: ModelCliProbeIo, hits: readonly string[]): string | null {
	if (hits.length === 0) return null;
	if (io.platform === 'win32') {
		const launchable = hits.find((hit) => WINDOWS_LAUNCHABLE.test(hit));
		if (launchable) return launchable;
		// `where` may list only the extension-less shim; `cmd.exe` cannot
		// run that, but the same directory almost always holds `<name>.cmd`.
		const sibling = `${hits[0]}.cmd`;
		return io.fileExists(sibling) ? sibling : null;
	}
	return hits[0];
}
