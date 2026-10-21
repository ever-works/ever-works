/**
 * Sessions on computers (FL-04) — the terminal the daemon gives each session.
 *
 * A session is an interactive process — an agent's TUI or a person's shell —
 * so it needs a REAL terminal: the `@homebridge/node-pty-prebuilt-multiarch`
 * addon the `pty-local` terminal host already ships (ConPTY on Windows, a
 * pty on macOS and Linux). There is deliberately no pipe floor here: a TUI
 * on a pipe renders garbage and cannot be resized, so when the addon is
 * missing the daemon reports `pty: missing` and the node withdraws the
 * `sessions` tag, naming the fix (spec U3) — it never pretends.
 *
 * The addon is a RUNTIME require (never a static import): bundlers would
 * trace it, and a machine without the prebuild must degrade, not crash on
 * module load. Everything that spawns goes through {@link PtyFactory}, so
 * the daemon is testable with any process host.
 */

/** One running terminal process. */
export interface PtyProcess {
	readonly pid: number | null;
	onData(listener: (data: string) => void): void;
	onExit(listener: (exit: { exitCode: number | null; signal?: number | null }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** Ask it to stop (`SIGTERM`-like); `force` kills it outright. */
	kill(force?: boolean): void;
}

export interface PtySpawnOptions {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;

export interface PtyAvailability {
	available: boolean;
	/** Why not, in words a person can act on. */
	reason?: string;
}

/** The structural slice of node-pty this file uses — typed locally so the addon stays a runtime require. */
interface NodePtyModule {
	spawn(
		file: string,
		args: string[],
		options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
	): {
		readonly pid: number;
		onData(listener: (data: string) => void): void;
		onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
		write(data: string): void;
		resize(cols: number, rows: number): void;
		kill(signal?: string): void;
	};
}

const PTY_ADDON = '@homebridge/node-pty-prebuilt-multiarch';

/** The fix a person can apply when the addon is missing. */
export const PTY_MISSING_HINT =
	'terminal support is missing on this computer — reinstall ever-works-node with npm so its terminal addon is installed';

let cached: { module: NodePtyModule | null; reason?: string } | null = null;

/**
 * Load the addon once. A load that fails — not installed, installed without
 * its native binary, built for another Node — is remembered as missing with
 * the loader's first line, never thrown.
 */
export function loadNodePty(require_: (id: string) => unknown = require): {
	module: NodePtyModule | null;
	reason?: string;
} {
	if (cached && require_ === require) return cached;
	let result: { module: NodePtyModule | null; reason?: string };
	try {
		const loaded = require_(PTY_ADDON) as Partial<NodePtyModule> | undefined;
		result =
			loaded && typeof loaded.spawn === 'function'
				? { module: loaded as NodePtyModule }
				: { module: null, reason: PTY_MISSING_HINT };
	} catch (error) {
		const first = (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0];
		result = { module: null, reason: `${PTY_MISSING_HINT} (${first.slice(0, 160)})` };
	}
	if (require_ === require) cached = result;
	return result;
}

/** A {@link PtyFactory} over the real addon, or null with the reason when it is unavailable. */
export function createNodePtyFactory(require_: (id: string) => unknown = require): {
	factory: PtyFactory | null;
	availability: PtyAvailability;
} {
	const { module, reason } = loadNodePty(require_);
	if (!module) return { factory: null, availability: { available: false, reason: reason ?? PTY_MISSING_HINT } };
	const factory: PtyFactory = (options) => {
		const child = module.spawn(options.command, options.args, {
			name: 'xterm-256color',
			cols: options.cols,
			rows: options.rows,
			cwd: options.cwd,
			env: options.env
		});
		return {
			pid: typeof child.pid === 'number' ? child.pid : null,
			onData: (listener) => child.onData(listener),
			onExit: (listener) =>
				child.onExit((event) =>
					listener({
						exitCode: typeof event.exitCode === 'number' ? event.exitCode : null,
						signal: typeof event.signal === 'number' ? event.signal : null
					})
				),
			write: (data) => child.write(data),
			resize: (cols, rows) => child.resize(cols, rows),
			kill: (force) => {
				try {
					// ConPTY ignores signal names; elsewhere SIGKILL is the forced stop.
					if (process.platform === 'win32') child.kill();
					else child.kill(force ? 'SIGKILL' : 'SIGTERM');
				} catch {
					// already gone
				}
			}
		};
	};
	return { factory, availability: { available: true } };
}
