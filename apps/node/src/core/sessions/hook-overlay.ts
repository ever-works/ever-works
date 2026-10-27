import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	FLEET_SESSION_CLAUDE_HOOK_EVENTS,
	FLEET_SESSION_CODEX_NOTIFY_EVENTS,
	isFleetDaemonSessionId,
	type FleetSessionClaudeHookEvent,
	type FleetSessionHooks,
	type FleetSessionKind,
	type FleetSessionStartableProvider
} from '@ever-works/contracts';
import type { Logger } from '../logger';
import { defaultHookFs, type HookFs, type HookPaths } from './hook-client';
import type { HookOverlay, HookOverlayPort } from './hook-overlay.port';

/**
 * Session status (FL-05, CONTRACTS R-6, plan §6.1 `hook-overlay.ts`, spec
 * FR-7 … FR-11, U10, U11) — the per-session hook overlay FL-04's launchers
 * ask for (`hookOverlayFor`), filled in.
 *
 * **The person's configuration is never written** (R-6, ACC-FL05-04): not
 * `~/.claude/settings.json`, not `~/.codex/config.toml`, nothing global. The
 * overlay is ADDED for one session:
 *
 *  - **Claude Code, owner session** — a generated settings file
 *    (`<state>/overlays/<sessionId>/settings.json`, owner-only) passed with
 *    `--settings`: one hook per event the installed version supports, each
 *    running the node's hook client with the provider and the session id.
 *    Claude Code layers it over the person's own settings, so their hooks,
 *    MCP servers and memory stay exactly as they are. Events the installed
 *    version predates are left out, and the session then says status for
 *    them comes from the screen (FR-10, U10).
 *  - **Codex, owner or Agent session** — `-c notify=[<node>, <client>, "codex",
 *    <sessionId>]` on the command line: Codex runs its notify program at the
 *    end of every turn. For an owner session it replaces the person's own
 *    notify command for THIS session only, and the session says so (U11).
 *    Agent sessions already run `--ignore-user-config` under an isolated
 *    `CODEX_HOME` (FL-04 P2): the command-line override is the one place a
 *    notify can still be given, so there is no home overlay file to write.
 *  - **Claude Code, Agent session** — NO overlay: the Task-run isolation runs
 *    every Agent session with `disableAllHooks` (FL-04 decision 37, never
 *    downgraded). Its status comes from the screen and the process (owner
 *    question FL-05 Q1).
 *
 * The overlay folder is removed when the session ends (FR-9).
 */

/** The oldest Claude Code release that fires each hook (version gating, FR-10). */
export const CLAUDE_HOOK_MIN_VERSION: Readonly<Record<FleetSessionClaudeHookEvent, string>> = {
	SessionStart: '1.0.62',
	UserPromptSubmit: '1.0.54',
	PermissionRequest: '2.0.45',
	PreToolUse: '1.0.38',
	PostToolUse: '1.0.38',
	Stop: '1.0.38',
	SessionEnd: '1.0.85',
	Notification: '1.0.38'
};

/** A hook gives the client this long (seconds) — it exits within 2 s on its own. */
const HOOK_TIMEOUT_SEC = 5;

/** `a.b.c` compared numerically; anything unparsable is "unknown" (null). */
export function compareVersions(a: string, b: string): number | null {
	const parse = (value: string) => {
		const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
		return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
	};
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return null;
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	}
	return 0;
}

/** The hook events this Claude Code version fires; an unknown version gets all of them. */
export function claudeHookEventsFor(version: string | null | undefined): FleetSessionClaudeHookEvent[] {
	return FLEET_SESSION_CLAUDE_HOOK_EVENTS.filter((event) => {
		if (!version) return true;
		const compared = compareVersions(version, CLAUDE_HOOK_MIN_VERSION[event]);
		return compared === null || compared >= 0;
	});
}

/** Characters a hook command line cannot carry safely in both cmd.exe and a POSIX shell. */
const UNSAFE_PATH_CHARS = /["%$`\r\n]/;

/**
 * The command a hook runs: the node's own Node binary on the generated client,
 * with the provider and the session id. POSIX: single-quoted. Windows:
 * double-quoted with forward slashes, which both cmd.exe and the bash some
 * CLIs use for hooks read as the same path. `null` when a path could not be
 * quoted safely (the session then reports status from the screen).
 */
export function hookCommandLine(
	nodePath: string,
	clientPath: string,
	provider: 'claude' | 'codex',
	sessionId: string,
	platform: string
): string | null {
	if (!isFleetDaemonSessionId(sessionId)) return null;
	if (platform === 'win32') {
		if (UNSAFE_PATH_CHARS.test(nodePath) || UNSAFE_PATH_CHARS.test(clientPath)) return null;
		const forward = (value: string) => value.replace(/\\/g, '/');
		return `"${forward(nodePath)}" "${forward(clientPath)}" ${provider} ${sessionId}`;
	}
	if (/[\r\n\0]/.test(nodePath) || /[\r\n\0]/.test(clientPath)) return null;
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
	return `${quote(nodePath)} ${quote(clientPath)} ${provider} ${sessionId}`;
}

/** The Claude Code settings overlay: one hook entry per event (`AskUserQuestion` for `PreToolUse`). */
export function claudeSettingsOverlay(
	command: string,
	events: readonly FleetSessionClaudeHookEvent[]
): { hooks: Record<string, unknown[]> } {
	const entry = { type: 'command', command, timeout: HOOK_TIMEOUT_SEC };
	const hooks: Record<string, unknown[]> = {};
	for (const event of events) {
		if (event === 'PreToolUse') hooks[event] = [{ matcher: 'AskUserQuestion', hooks: [entry] }];
		else if (event === 'PostToolUse') hooks[event] = [{ matcher: '*', hooks: [entry] }];
		else hooks[event] = [{ hooks: [entry] }];
	}
	return { hooks };
}

/** `-c notify=[…]` value: a TOML array of basic strings (JSON string escapes are valid TOML). */
export function codexNotifyOverride(argv: readonly string[]): string {
	return `notify=[${argv.map((part) => JSON.stringify(part)).join(',')}]`;
}

/** Whether the person's own Codex configuration names a notify command (read only, never written). */
export async function personHasCodexNotify(
	env: Record<string, string | undefined>,
	homedir: string,
	readFile: (file: string) => Promise<string> = (file) => fsp.readFile(file, 'utf8')
): Promise<boolean> {
	const home = env.CODEX_HOME?.trim() || path.join(homedir, '.codex');
	try {
		const config = await readFile(path.join(home, 'config.toml'));
		return /^\s*notify\s*=/m.test(config);
	} catch {
		return false;
	}
}

export interface SessionHookOverlayOptions {
	paths: HookPaths;
	/** The Node binary that runs the hook client — the node's own. */
	nodePath: string;
	platform: string;
	homedir: string;
	env: Record<string, string | undefined>;
	/** The installed CLI's version, when the node knows it (version gating). */
	cliVersion?: (provider: 'claude-code' | 'codex') => Promise<string | null> | string | null;
	fs?: HookFs;
	/** Removes a folder and everything in it (the session's overlay, at its end). */
	removeDir?: (target: string) => Promise<void>;
	readFile?: (file: string) => Promise<string>;
	restrictFile?: (file: string) => Promise<void> | void;
	logger?: Logger;
}

export class SessionHookOverlay implements HookOverlayPort {
	private readonly injected = new Map<string, FleetSessionHooks>();
	private readonly fs: HookFs;
	private readonly join: (...parts: string[]) => string;

	constructor(private readonly options: SessionHookOverlayOptions) {
		this.fs = options.fs ?? defaultHookFs;
		this.join = options.platform === 'win32' ? path.win32.join : path.posix.join;
	}

	/** What was injected for a session the node launched (null when it launched none). */
	hooksFor(sessionId: string): FleetSessionHooks | null {
		return this.injected.get(sessionId) ?? null;
	}

	/** Record what a session got without an overlay (a shell, a session started before this node). */
	remember(sessionId: string, hooks: FleetSessionHooks): void {
		if (!this.injected.has(sessionId)) this.injected.set(sessionId, hooks);
	}

	async hookOverlayFor(
		kind: FleetSessionKind,
		provider: FleetSessionStartableProvider,
		sessionId: string
	): Promise<HookOverlay | null> {
		if (!isFleetDaemonSessionId(sessionId)) return null;
		const env = { EVER_WORKS_SESSION_ID: sessionId };
		try {
			if (provider === 'shell') {
				this.injected.set(sessionId, { provider, injected: false, events: [] });
				return null;
			}
			if (provider === 'codex') {
				const command = [this.options.nodePath, this.options.paths.clientPath, 'codex', sessionId].map(
					(part) => (this.options.platform === 'win32' ? part.replace(/\\/g, '/') : part)
				);
				const notifyReplaced =
					kind === 'owner' &&
					(await personHasCodexNotify(this.options.env, this.options.homedir, this.options.readFile));
				const hooks: FleetSessionHooks = {
					provider,
					injected: true,
					events: [...FLEET_SESSION_CODEX_NOTIFY_EVENTS],
					...(notifyReplaced ? { notifyReplaced: true } : {})
				};
				this.injected.set(sessionId, hooks);
				return { args: ['-c', codexNotifyOverride(command)], env, hooks };
			}
			// Claude Code.
			if (kind === 'agent') {
				// The Task-run isolation runs Agent sessions with `disableAllHooks` (never downgraded).
				const hooks: FleetSessionHooks = { provider, injected: false, events: [] };
				this.injected.set(sessionId, hooks);
				return { args: [], env, hooks };
			}
			const command = hookCommandLine(
				this.options.nodePath,
				this.options.paths.clientPath,
				'claude',
				sessionId,
				this.options.platform
			);
			if (!command) {
				this.options.logger?.warn(
					'Session status: the hook command could not be quoted; status comes from the screen'
				);
				const hooks: FleetSessionHooks = { provider, injected: false, events: [] };
				this.injected.set(sessionId, hooks);
				return { args: [], env, hooks };
			}
			const version = this.options.cliVersion ? await this.options.cliVersion('claude-code') : null;
			const events = claudeHookEventsFor(version);
			const dir = this.join(this.options.paths.overlaysDir, sessionId);
			const file = this.join(dir, 'settings.json');
			await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
			await this.fs.writeFile(file, `${JSON.stringify(claudeSettingsOverlay(command, events), null, 2)}\n`, {
				mode: 0o600
			});
			if (this.options.restrictFile) await this.options.restrictFile(file);
			const hooks: FleetSessionHooks = { provider, injected: true, events: [...events] };
			this.injected.set(sessionId, hooks);
			return { args: ['--settings', file], env, hooks };
		} catch (error) {
			// An overlay that cannot be written never stops the session: it runs, status from the screen.
			this.options.logger?.warn(
				`Session status: no hook overlay for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
			);
			const hooks: FleetSessionHooks = { provider, injected: false, events: [] };
			this.injected.set(sessionId, hooks);
			return { args: [], env, hooks };
		}
	}

	/** The session ended: its overlay folder goes (FR-9). Never throws. */
	async release(sessionId: string): Promise<void> {
		this.injected.delete(sessionId);
		if (!isFleetDaemonSessionId(sessionId)) return;
		const dir = this.join(this.options.paths.overlaysDir, sessionId);
		const remove = this.options.removeDir ?? ((target: string) => fsp.rm(target, { recursive: true, force: true }));
		await remove(dir).catch(() => undefined);
	}
}
