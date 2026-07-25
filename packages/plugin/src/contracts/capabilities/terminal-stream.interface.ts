import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';
import type { TerminalFrame } from '@ever-works/contracts';

/**
 * Streaming-terminal capability — pluggable hosts for live, typable
 * agent terminal sessions (capability `terminal-stream`).
 *
 * The split of responsibilities is what makes providers swappable:
 *
 *  - The **plugin** owns WHERE and HOW the process runs: the first-party
 *    `pty-local` plugin spawns a real PTY inside the executing
 *    job-runtime worker (degrading to a `child_process` pipe floor with
 *    no resize when the native prebuild is unavailable); a future
 *    `pty-ssh` plugin execs on the user's own Linux box; a `k8s-exec`
 *    provider is the same contract again. A plugin NEVER talks to
 *    browsers.
 *  - The **transport** is constructed by the platform (the worker-side
 *    session host): outbound = the API's internal frame-publish
 *    endpoint; inbound = the worker's own authenticated WebSocket
 *    attach. The plugin just pumps bytes against it.
 *  - The **relay** (gateway + registry in the API) owns fan-out,
 *    backlog, scrollback, and auth.
 *
 * Wire types come from `@ever-works/contracts` — one frozen frame
 * protocol across plugin, worker, API, and browser.
 */

/** Inputs to spawn one terminal session. */
export interface TerminalSpawnInput {
	/** Relay channel id == AgentRun id, minted BEFORE dispatch so the
	 *  browser-attach id equals the worker-publish id by construction. */
	readonly runId: string;
	/** Argv to exec — the pipeline plugin's CLI invocation. Absolute
	 *  path preferred: bundled workers have unreliable PATHs. */
	readonly command: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly initialSize?: { cols: number; rows: number };
	/** Frames to publish BEFORE spawn (error-banner preamble — a viewer
	 *  must never stare at a silently-black terminal). */
	readonly preamble?: readonly TerminalFrame[];
	/** Kill the child when the inbound leg closes (cost guard;
	 *  policy-controlled by the caller, NOT a plugin decision). */
	readonly endOnInputClose?: boolean;
	/** Resolved plugin settings injected by the facade. */
	readonly settings?: PluginSettings;
}

/** Handle to a live hosted process (PTY or pipe-floor fallback). */
export interface TerminalSessionHandle {
	readonly runId: string;
	/** True PTY (resizable) vs `child_process` pipe floor (no resize —
	 *  the UI renders an honest `isPty:false` banner). */
	readonly isPty: boolean;
	write(data: Uint8Array): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	/**
	 * Resolves with the final exit outcome. Implementations MUST have
	 * published the terminal `exit` frame (awaited, not fire-and-forget)
	 * before resolving — the browser must always learn the session ended.
	 */
	readonly exited: Promise<{ code: number; reason: 'completed' | 'crashed' | 'closed' }>;
}

/**
 * The byte path between the hosted process and the relay. Constructed
 * by the platform; consumed by the plugin's pump loop.
 */
export interface TerminalTransport {
	/** Outbound leg — deliver a frame toward the relay. Data frames are
	 *  fire-and-forget (the transport owns retry/batching); the final
	 *  `exit` frame is awaited by the session handle contract above. */
	publish(frame: TerminalFrame): void;
	/** Inbound leg — async-iterable of browser→worker frames
	 *  (stdin/resize), already auth-checked and role-checked upstream. */
	inbound(): AsyncIterable<TerminalFrame>;
	close(): Promise<void>;
}

/**
 * Thrown from `spawn()` when the provider's runtime dependencies are
 * missing (no PTY prebuild AND no child_process floor, SSH host
 * unreachable, …). Matched BY NAME across package boundaries (the
 * FacadeError house pattern); the UI maps it to the `cannot-connect`
 * state — an unconfigured install degrades loudly, never silently.
 */
export class TerminalNotProvisionedError extends Error {
	constructor(message?: string) {
		super(message ?? 'Terminal session host is not provisioned in this runtime.');
		this.name = 'TerminalNotProvisionedError';
	}
}

/**
 * Streaming-terminal plugin interface — capability `terminal-stream`.
 */
export interface ITerminalStreamPlugin extends IPlugin {
	/** Provider name for facade identification ('pty-local', 'pty-ssh', ...). */
	readonly providerName: string;

	/**
	 * Spawn the process and pump it against the given transport until
	 * exit. Resolves once the session is LIVE (spawned and pumping);
	 * the returned handle's `exited` promise tracks completion.
	 * MUST throw {@link TerminalNotProvisionedError} when runtime deps
	 * are missing.
	 */
	spawn(input: TerminalSpawnInput, transport: TerminalTransport): Promise<TerminalSessionHandle>;

	/** Optional provider-level liveness probe (SSH box reachable, PTY
	 *  prebuild present, …) for settings-page diagnostics. */
	probe?(settings?: PluginSettings): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Facade interface — the surface API controllers / task orchestrators
 * call. The implementation lives in `@ever-works/agent` as
 * `TerminalStreamFacadeService`. `FacadeOptions` is imported by the
 * implementation, not the contract — this file stays dep-light.
 */
export interface ITerminalStreamFacade {
	resolveProvider(facadeOptions: unknown): Promise<ITerminalStreamPlugin | null>;
	spawn(
		input: Omit<TerminalSpawnInput, 'settings'>,
		transport: TerminalTransport,
		facadeOptions: unknown
	): Promise<TerminalSessionHandle>;
}

/**
 * Type guard — true when a plugin declares the `terminal-stream` capability.
 */
export function isTerminalStreamPlugin(plugin: IPlugin): plugin is ITerminalStreamPlugin {
	return plugin.capabilities.includes('terminal-stream');
}
