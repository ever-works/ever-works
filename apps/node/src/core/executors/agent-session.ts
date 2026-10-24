import { promises as fsp } from 'fs';
import { homedir } from 'os';
import path, { join } from 'path';
import {
	FLEET_SESSION_END_GRACE_MS,
	fleetSessionOutcomeForExit,
	makeFleetLinkError,
	parseFleetAgentSessionPayload,
	type FleetAgentSessionPayload,
	type FleetAgentSessionResult,
	type FleetJobView,
	type FleetLinkErrorCode,
	type FleetSessionEndedReason
} from '@ever-works/contracts';
import { buildNodeCheckEnv, type NodeCommandEnvOverlay } from './acceptance-checks';
import {
	defaultScratchFs,
	defaultScratchRoot,
	establishModelContainment,
	refuseUnderClaudeManagedMcpConfig,
	scratchDirName,
	type AgentTaskIo,
	type AgentTaskScratchFs
} from './agent-task';
import { MODEL_CLI_EMPTY_MCP_CONFIG, MODEL_CLI_FLEET_SETTINGS, modelCliMcpIsolationEnv } from './model-cli';
import { expandHome } from '../sessions/owner-session-launcher';
import type { HookOverlayPort } from '../sessions/hook-overlay.port';
import type { DaemonSessionInfo, DaemonWatchEvent } from '../sessions/daemon/daemon-protocol';

/**
 * Sessions on computers (FL-04 P2, spec FR-42 … FR-50, plan §6.1) — the
 * `agent-session` job: an Agent working in an INTERACTIVE terminal session on
 * this machine, owned by the session daemon (so it outlives this process), for
 * as long as the lease is held.
 *
 * ## The isolation is the Task run's, reused — never downgraded
 *
 * The CLI starts exactly as contained as an `agent-task` model step on this
 * node, through the SAME code (`agent-task.ts`, exported for this):
 *
 *  - `establishModelContainment` — the per-run isolated home (relocated CLI
 *    configuration home, mirrored session home, the `claudeConfigRelocationLoss`
 *    gate). Where an `agent-task` would DOWNGRADE (run un-isolated with the
 *    reason recorded), an Agent session REFUSES `unsupported_on_node` with that
 *    reason: an interactive session the owner may not be watching is never run
 *    in the owner's own configuration (spec FR-44, FR-45);
 *  - `refuseUnderClaudeManagedMcpConfig` — a machine whose administrator
 *    deployed a managed MCP config refuses, as a Task run does;
 *  - MCP: an EMPTY strict config (`MODEL_CLI_EMPTY_MCP_CONFIG` +
 *    `--strict-mcp-config`) and `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so no MCP
 *    server the platform did not vet — the owner's, a plugin's, a repository's —
 *    loads; the platform's tool bridge for sessions is a follow-up (lane log);
 *  - control 17: `--setting-sources user --settings <fleet settings>` (no
 *    repository settings, no hooks) for Claude Code; `--ignore-user-config`
 *    for Codex (control 16);
 *  - the environment is `buildNodeCheckEnv`'s scrubbed allow-list with the
 *    containment overlay applied last.
 *
 * What differs from a Task run is only the launch: interactive (no `-p`, no
 * `--output-format`), the first message as the prompt argument, inside a
 * daemon terminal the owner can watch and take over.
 *
 * ## Lifecycle
 *
 * The worker loop keeps the lease alive while this executor runs. It waits
 * for the daemon's `exited` (or the session vanishing from `list`), and
 * completes with the exit evidence. An aborted job (the platform cancelled
 * it, the lease was lost, the node drains) ends the session first.
 */

/** A refusal the platform reads as the CONTRACTS §8 code it names. */
export class AgentSessionRefusal extends Error {
	constructor(
		readonly code: FleetLinkErrorCode,
		readonly hint: string
	) {
		super(`${code}: ${hint}`);
		this.name = 'AgentSessionRefusal';
	}

	toLinkError() {
		return makeFleetLinkError(this.code, this.hint);
	}
}

/** The daemon, as this executor uses it. */
export interface AgentSessionDaemon {
	request<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
	onEvent(listener: (event: DaemonWatchEvent) => void): () => void;
}

export interface AgentSessionIo {
	/** `--work` is on (FR-46). */
	workEnabled: boolean;
	daemon: AgentSessionDaemon | null;
	/** The CLI paths this node resolved. */
	modelCli: Partial<Record<'claude-code' | 'codex', string>>;
	/** The containment seams `agent-task` uses (parent env, platform, config readers, session homes). */
	containment: AgentTaskIo;
	/** This node's enrollment id: a job pinned to another node is refused. */
	nodeId?: string;
	homedir?: string;
	extraRoots?: readonly string[];
	scratchRoot?: string;
	scratchFs?: AgentTaskScratchFs;
	platform?: NodeJS.Platform;
	overlay?: HookOverlayPort;
	realpath?: (target: string) => Promise<string>;
	/** How often the session is re-listed in case an `exited` event was missed. */
	pollMs?: number;
	/** Delay before a `.cmd` CLI's first message is typed (Windows). */
	typeAfterStartMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

const POLL_MS = 15_000;

function isWithin(child: string, parent: string, platform: string): boolean {
	const paths = platform === 'win32' ? path.win32 : path.posix;
	const relative = paths.relative(
		platform === 'win32' ? parent.toLowerCase() : parent,
		platform === 'win32' ? child.toLowerCase() : child
	);
	return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative));
}

/** The session folder: `~` expanded, symlinks resolved, inside the home folder or an extra root. */
export async function resolveAgentSessionFolder(
	cwd: string,
	io: Pick<AgentSessionIo, 'homedir' | 'extraRoots' | 'platform' | 'realpath'>
): Promise<string> {
	const platform = io.platform ?? process.platform;
	const home = io.homedir ?? homedir();
	const realpath = io.realpath ?? ((target: string) => fsp.realpath(target));
	const requested = expandHome(cwd.trim(), home, platform);
	const absolute = platform === 'win32' ? path.win32.isAbsolute(requested) : path.posix.isAbsolute(requested);
	if (!absolute) throw new AgentSessionRefusal('invalid', `${cwd} is not a full path on this computer`);
	let resolved: string;
	try {
		resolved = await realpath(requested);
	} catch {
		throw new AgentSessionRefusal('invalid', `${cwd} does not exist on this computer`);
	}
	const roots: string[] = [];
	for (const root of [home, ...(io.extraRoots ?? [])]) {
		try {
			roots.push(await realpath(root));
		} catch {
			// a root that does not exist admits nothing
		}
	}
	if (!roots.some((root) => isWithin(resolved, root, platform))) {
		throw new AgentSessionRefusal(
			'invalid',
			`${cwd} is outside the home folder on this computer; Agent sessions start in the home folder or a folder the machine's owner allowed`
		);
	}
	return resolved;
}

/** The interactive argv for one Agent session (no `-p`, no `--output-format`). */
export function buildAgentSessionArgv(input: {
	payload: Pick<FleetAgentSessionPayload, 'provider' | 'permissionMode' | 'firstMessage'>;
	executable: string;
	cwd: string;
	emptyMcpConfigPath: string;
	settingsPath: string;
	overlayArgs?: readonly string[];
	platform: NodeJS.Platform;
}): { command: string[]; typeAfterStart?: string } {
	const { payload } = input;
	const args: string[] = [];
	if (payload.provider === 'claude-code') {
		args.push(
			'--permission-mode',
			payload.permissionMode,
			// `--mcp-config` is variadic: `--strict-mcp-config` closes its list.
			'--mcp-config',
			input.emptyMcpConfigPath,
			'--strict-mcp-config',
			'--setting-sources',
			'user',
			'--settings',
			input.settingsPath
		);
	} else {
		const sandbox = payload.permissionMode === 'plan' ? 'read-only' : 'workspace-write';
		args.push('--ignore-user-config', '--sandbox', sandbox, '-C', input.cwd);
	}
	args.push(...(input.overlayArgs ?? []));
	const command = [input.executable, ...args];
	// A Windows `.cmd` / `.bat` CLI re-parses its command line through cmd.exe
	// (`& | ^ %`): its first message is typed into the session instead.
	if (input.platform === 'win32' && /\.(cmd|bat)$/i.test(input.executable)) {
		return { command, typeAfterStart: payload.firstMessage };
	}
	return { command: [...command, payload.firstMessage] };
}

function isInfoList(value: unknown): value is { sessions: DaemonSessionInfo[] } {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as { sessions?: unknown }).sessions)
	);
}

/**
 * Run one `agent-session` job. Resolves with {@link FleetAgentSessionResult}
 * (as the job result) when the session ended; throws an
 * {@link AgentSessionRefusal} when it could not start.
 */
export async function runAgentSessionJob(
	job: FleetJobView,
	signal: AbortSignal,
	io: AgentSessionIo
): Promise<Record<string, unknown>> {
	const payload = parseFleetAgentSessionPayload(job.payload);
	if (!payload) throw new AgentSessionRefusal('invalid', 'this Agent session request is not one this node understands');
	if (!io.workEnabled) {
		throw new AgentSessionRefusal('consent_missing', 'Agent sessions need work switched on: ever-works-node start --work');
	}
	if (io.nodeId && payload.nodeId !== io.nodeId) {
		throw new AgentSessionRefusal('invalid', 'this Agent session was started on another computer');
	}
	const daemon = io.daemon;
	if (!daemon) {
		throw new AgentSessionRefusal('unsupported_on_node', 'the session daemon is not running on this computer');
	}
	const executable = io.modelCli[payload.provider];
	if (typeof executable !== 'string' || !executable.trim()) {
		throw new AgentSessionRefusal(
			'unsupported_on_node',
			`${payload.provider === 'codex' ? 'Codex' : 'Claude Code'} is not installed on this computer`
		);
	}
	const platform = io.platform ?? process.platform;
	const cwd = await resolveAgentSessionFolder(payload.cwd, io);

	const scratchFs = io.scratchFs ?? defaultScratchFs;
	const scratchDir = await scratchFs.createScratchDir(
		io.scratchRoot ?? defaultScratchRoot(),
		`session-${scratchDirName(job.id)}`
	);
	try {
		await refuseUnderClaudeManagedMcpConfig(payload.provider, io.containment);
		const containment = await establishModelContainment(payload.provider, scratchDir, scratchFs, io.containment);
		if (!containment.record.isolatedHome) {
			const reason =
				containment.record.downgrades.find((entry) => entry.control === 'isolated-home')?.reason ??
				'the per-run isolated home could not be built';
			throw new AgentSessionRefusal(
				'unsupported_on_node',
				`Agent sessions run only under the Task-run isolation, which this computer could not give: ${reason}`
			);
		}
		const mcpIsolation = modelCliMcpIsolationEnv(payload.provider);
		const overlay: NodeCommandEnvOverlay = { ...(containment.envOverlay ?? {}), ...(mcpIsolation ?? {}) };
		const hook = io.overlay ? await io.overlay.hookOverlayFor('agent', payload.provider, payload.fleetSessionId) : null;
		const env = buildNodeCheckEnv(null, io.containment.parentEnv, null, overlay) as Record<string, string>;
		for (const [key, value] of Object.entries(hook?.env ?? {})) env[key] = value;
		env.EVER_WORKS_SESSION_ID = payload.fleetSessionId;

		const emptyMcpConfigPath = join(scratchDir, 'mcp.json');
		const settingsPath = join(scratchDir, 'claude-settings.json');
		await scratchFs.writeFile(emptyMcpConfigPath, MODEL_CLI_EMPTY_MCP_CONFIG);
		await scratchFs.writeFile(settingsPath, MODEL_CLI_FLEET_SETTINGS);
		const launch = buildAgentSessionArgv({
			payload,
			executable: executable.trim(),
			cwd,
			emptyMcpConfigPath,
			settingsPath,
			...(hook?.args ? { overlayArgs: hook.args } : {}),
			platform
		});

		if (signal.aborted) throw new AgentSessionRefusal('busy', 'the session was cancelled before it started');
		await daemon.request('start', {
			sessionId: payload.fleetSessionId,
			kind: 'agent',
			provider: payload.provider,
			command: launch.command,
			cwd,
			env,
			cols: payload.cols,
			rows: payload.rows,
			title: payload.title,
			startedBy: `agent:${payload.agentId}`
		});
		const setTimer = io.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
		if (launch.typeAfterStart) {
			const text = launch.typeAfterStart;
			setTimer(() => {
				void daemon.request('input', { sessionId: payload.fleetSessionId, data: `${text}\r` }).catch(() => undefined);
			}, io.typeAfterStartMs ?? 1_500);
		}

		const exit = await waitForSessionExit(daemon, payload.fleetSessionId, signal, io);
		const result: FleetAgentSessionResult = {
			exitCode: exit.exitCode,
			outcome: exit.reason && exit.reason !== 'exit' ? 'cancelled' : fleetSessionOutcomeForExit(exit.exitCode),
			...(exit.reason ? { endedReason: exit.reason } : {}),
			providerSessionId: null
		};
		return result as unknown as Record<string, unknown>;
	} finally {
		// The isolated home lives exactly as long as the session; a session that
		// never started leaves nothing behind either.
		await scratchFs.remove(scratchDir).catch(() => undefined);
	}
}

/**
 * Wait until the daemon reports the session ended (`exited`), or it vanished
 * from `list` (a missed event, a daemon restart). An abort ends the session
 * first (terminate, kill after the grace) and then waits for its exit.
 */
async function waitForSessionExit(
	daemon: AgentSessionDaemon,
	sessionId: string,
	signal: AbortSignal,
	io: Pick<AgentSessionIo, 'pollMs' | 'setTimer' | 'clearTimer'>
): Promise<{ exitCode: number | null; reason: FleetSessionEndedReason | null }> {
	const setTimer = io.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer = io.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	return new Promise((resolve) => {
		let done = false;
		let poll: unknown = null;
		const finish = (exitCode: number | null, reason: FleetSessionEndedReason | null) => {
			if (done) return;
			done = true;
			unsubscribe();
			if (poll !== null) clearTimer(poll);
			signal.removeEventListener('abort', onAbort);
			resolve({ exitCode, reason });
		};
		const unsubscribe = daemon.onEvent((event) => {
			if (event.id !== sessionId || event.event !== 'exited') return;
			finish(event.exitCode, event.reason);
		});
		const onAbort = () => {
			// Cancelled, lease lost, or the node drains: the session ends with the job.
			void daemon
				.request('end', { sessionId, reason: 'agent', graceMs: FLEET_SESSION_END_GRACE_MS })
				.catch(() => undefined)
				.finally(() => {
					// The daemon's `exited` normally arrives first; never wait forever for it.
					setTimer(() => finish(null, 'agent'), FLEET_SESSION_END_GRACE_MS + 2_000);
				});
		};
		const check = () => {
			poll = null;
			if (done) return;
			void daemon
				.request('list')
				.then((listed) => {
					if (done || !isInfoList(listed)) return;
					const info = listed.sessions.find((entry) => entry.id === sessionId);
					if (!info) return finish(null, null);
					if (!info.alive) return finish(info.exitCode, info.endReason);
				})
				.catch(() => undefined)
				.finally(() => {
					if (!done) poll = setTimer(check, io.pollMs ?? POLL_MS);
				});
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
		poll = setTimer(check, io.pollMs ?? POLL_MS);
	});
}
