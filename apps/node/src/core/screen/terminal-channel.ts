import type { ITerminalStreamPlugin, TerminalSessionHandle, TerminalTransport } from '@ever-works/plugin';
import type { TerminalFrame } from '@ever-works/contracts';
import { buildNodeCheckEnv } from '../executors/acceptance-checks';

/**
 * Agent computers — the terminal channel: a shell on THIS machine, streamed
 * into a live view.
 *
 * It does not host a process itself. It hands a shell command to whichever
 * `terminal-stream` provider the node was built with (the first-party
 * `pty-local` plugin: a real PTY when its prebuild is present, an honest
 * pipe floor otherwise) through the existing terminal capability contract,
 * and wraps every `TerminalFrame` it publishes in the computer protocol's
 * `terminal` envelope — the SAME terminal protocol the Agent Terminal tab
 * already renders, so the browser needs no second renderer.
 *
 * While watching, the channel is read-only by construction: its inbound
 * leg yields nothing, so no keystroke can reach the shell. (Typing is a
 * take-over concern and arrives with it.) Every frame still passes the
 * outbox's secret scan before it leaves the machine.
 */

export interface NodeShellCommand {
	command: string[];
}

/** The machine's own interactive shell: PowerShell on Windows, the login shell elsewhere. */
export function resolveNodeShell(platform: string, env: Record<string, string | undefined>): NodeShellCommand {
	if (platform === 'win32') {
		return { command: ['powershell.exe', '-NoLogo'] };
	}
	const shell = env.SHELL?.trim();
	return { command: [shell && shell.startsWith('/') ? shell : '/bin/sh'] };
}

export interface NodeTerminalChannelOptions {
	host: ITerminalStreamPlugin;
	sessionId: string;
	/** The watched Agent's own file root. */
	cwd: string;
	publish: (frame: TerminalFrame) => void;
	platform?: string;
	parentEnv?: NodeJS.ProcessEnv;
}

export interface NodeTerminalChannel {
	readonly isPty: boolean;
	stop(): Promise<void>;
}

export async function startNodeTerminalChannel(options: NodeTerminalChannelOptions): Promise<NodeTerminalChannel> {
	const parentEnv = options.parentEnv ?? process.env;
	const shell = resolveNodeShell(options.platform ?? process.platform, parentEnv);
	let stopInbound: () => void = () => undefined;
	const inboundDone = new Promise<void>((resolve) => {
		stopInbound = resolve;
	});
	let closed = false;
	const transport: TerminalTransport = {
		publish: (frame) => {
			if (!closed) options.publish(frame);
		},
		inbound: () => readOnlyInbound(inboundDone),
		close: async () => {
			closed = true;
		}
	};
	const handle: TerminalSessionHandle = await options.host.spawn(
		{
			// The relay channel id: a live view's terminal is keyed by its session.
			runId: options.sessionId,
			command: shell.command,
			cwd: options.cwd,
			// The node's scrubbed, allowlisted environment — never its own credential namespace.
			env: { ...buildNodeCheckEnv(null, parentEnv), TERM: 'xterm-256color' },
			endOnInputClose: false
		},
		transport
	);
	let stopped = false;
	return {
		isPty: handle.isPty,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			// Outbound closes FIRST: a shell that ignores the kill must not keep
			// publishing into a view this channel has already reported stopped.
			closed = true;
			stopInbound();
			try {
				handle.kill();
			} catch {
				// already gone
			}
			await Promise.race([handle.exited.then(() => undefined), delay(3000)]);
		}
	};
}

/** An inbound leg that yields nothing and ends when the channel stops. */
async function* readOnlyInbound(done: Promise<void>): AsyncIterable<TerminalFrame> {
	await done;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
