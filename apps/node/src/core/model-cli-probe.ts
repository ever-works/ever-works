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
	/** True when the path is an existing file this process may execute. */
	fileExists(path: string): boolean;
	/** Every PATH hit for a bare command, first match first; `[]` when none. */
	lookupAllOnPath?(command: string): string[];
	/** Single-hit variant kept for callers that only have `which`. */
	lookupOnPath?(command: string): string | null;
}

export const MODEL_CLI_ENV_OVERRIDES = {
	'claude-code': 'EVER_WORKS_NODE_CLAUDE_PATH',
	codex: 'EVER_WORKS_NODE_CODEX_PATH'
} as const;

const MODEL_CLI_COMMANDS = {
	'claude-code': 'claude',
	codex: 'codex'
} as const;

/** Windows launches `.cmd` / `.exe` shims; the extension-less npm shim is a bash script. */
const WINDOWS_LAUNCHABLE = /\.(cmd|exe|bat)$/i;

export interface ModelCliProbeResult {
	paths: ModelCliPaths;
	/** One line per CLI explaining what was chosen (or why not), for the startup log. */
	notes: string[];
}

export function resolveModelCliPaths(
	io: ModelCliProbeIo,
	overrides: Partial<Record<keyof typeof MODEL_CLI_COMMANDS, string | null | undefined>> = {}
): ModelCliProbeResult {
	const paths: ModelCliPaths = {};
	const notes: string[] = [];
	for (const provider of Object.keys(MODEL_CLI_COMMANDS) as Array<keyof typeof MODEL_CLI_COMMANDS>) {
		const pinned = (overrides[provider] ?? io.env[MODEL_CLI_ENV_OVERRIDES[provider]] ?? '').trim();
		if (pinned) {
			if (io.fileExists(pinned)) {
				paths[provider] = pinned;
				notes.push(`${provider}: ${pinned} (pinned)`);
			} else {
				paths[provider] = null;
				notes.push(`${provider}: disabled — pinned path does not exist or is not executable: ${pinned}`);
			}
			continue;
		}
		const found = pickLaunchable(io, MODEL_CLI_COMMANDS[provider]);
		paths[provider] = found;
		notes.push(found ? `${provider}: ${found} (PATH)` : `${provider}: not found on PATH`);
	}
	return { paths, notes };
}

function pickLaunchable(io: ModelCliProbeIo, command: string): string | null {
	const hits = io.lookupAllOnPath
		? io.lookupAllOnPath(command)
		: io.lookupOnPath
			? [io.lookupOnPath(command)].filter((hit): hit is string => typeof hit === 'string' && hit.length > 0)
			: [];
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
