import {
	encodeFleetLinkExit,
	FleetCommandEdgeBuffer,
	FLEET_COMMAND_CANCEL_EXIT_CODE,
	FLEET_COMMAND_DATA_CHUNK_BYTES,
	FLEET_COMMAND_STOPPED_EXIT_CODE,
	FLEET_COMMAND_TIMEOUT_EXIT_CODE,
	FLEET_LINK_FRAME_KINDS,
	fleetConsentMissingHint,
	makeFleetLinkError,
	parseFleetCommandChannelParams,
	parseFleetCommandRunParams,
	type FleetCommandChannelParams,
	type FleetCommandNodeEndReason,
	type FleetCommandOutputMessage,
	type FleetCommandRunParams,
	type FleetConsents,
	type FleetLinkError
} from '@ever-works/contracts';
import type { Logger } from '../../logger';
import { buildNodeCheckEnv } from '../../executors/acceptance-checks';
import { resolveLoginShell } from '../../sessions/owner-session-launcher';
import { resolveCommandFolder } from './command/command-folder';
import type { CommandOutputStore, CommandOutputWriter } from './command/command-output-store';
import { startCommand, type CommandRunHandle } from './command/command-runner';
import type { NodeChannelContext, NodeChannelHandler, NodeModule } from './registry';

/**
 * Fleet node link — the `command` family (FL-12, CONTRACTS §3.3, R-11, R-24,
 * R-40): the node's half of Commands on computers.
 *
 * One channel per run, opened by the platform with `{ commandId, nodeId,
 * runId }`:
 *
 *  - `command.run { runId, command, cwd?, timeoutSec }` — the command runs in
 *    the machine owner's login shell (FL-04's `resolveLoginShell`: `$SHELL -l`,
 *    `pwsh`/Windows PowerShell on Windows) with no stdin, in the home folder or
 *    a folder the machine's owner allowed, with the scrubbed environment
 *    (`buildNodeCheckEnv`: never `FLEET_*` / `EVER_WORKS_*`). The reply says it
 *    started; then `DATA` (≤ 64 KiB each, stdout + stderr as emitted, until
 *    10 MiB — then `command.truncated`), `command.timeout` when the timeout
 *    fired, `command.output` (the head and tail this machine kept, how it
 *    ended), `EXIT [code]` and `channel.close`.
 *  - `command.read { runId }` (P2, "Open full output") — the run's kept
 *    output from this machine's store, as `DATA` then `END` on its own channel.
 *  - `command.cancel { runId }` — on ANY command channel (the platform opens a
 *    short-lived one, so a cancel works from whichever API replica took it):
 *    the run is found by its id and its tree ended; its own channel reports
 *    `cancelled-by-user` and `EXIT 130`.
 *
 * Consent, on this machine: `--manage` (checked by the channel table before
 * this family is asked, and again here). Kill switch (`link.pause`, R-24):
 * every running command is stopped (`kill-switch`, `EXIT 137`) and new runs are
 * refused `kill_switch`. Drain (`link.drain`): every running command is stopped
 * (`drain`, `EXIT 137`).
 *
 * A link drop does not stop a command: it keeps running and keeps writing its
 * full output to this machine's store; the channel is offered back on the
 * reconnect and, when it resumes, the end is reported then (spec U2). A
 * channel the platform closes while its command runs ends the command.
 */

export interface CommandModuleOptions {
	consents: FleetConsents;
	nodeName: string;
	platform: string;
	homedir: string;
	/** This process's environment: the login shell is read from it, and the command's is scrubbed from it. */
	env: Record<string, string | undefined>;
	/** Folders besides home that commands may run in (the owner sessions' `--…-root` list). */
	extraRoots?: readonly string[];
	/** The last 30 runs' full output; absent = none kept. */
	store?: CommandOutputStore | null;
	/**
	 * Schedules on computers (FL-13): where else a run's full output may be
	 * kept — a schedule's own ring of 30 — for "Open full output" on a
	 * schedule's run (`command.read`). Null when no store holds it.
	 */
	findStore?: (runId: string) => Promise<CommandOutputStore | null>;
	logger?: Logger;
	/** Test seams. */
	start?: typeof startCommand;
	realpath?: (target: string) => Promise<string>;
	now?: () => number;
}

interface RunningCommand {
	runId: string;
	stop(reason: FleetCommandNodeEndReason): void;
}

type Reply = { result: unknown } | { error: FleetLinkError };

const KILL_SWITCH_HINT = 'clear it under Settings → Fleet';

export function createCommandModule(options: CommandModuleOptions): NodeModule {
	const now = options.now ?? (() => Date.now());
	const start = options.start ?? startCommand;
	/** Every command running on this machine, by the platform's run id. */
	const running = new Map<string, RunningCommand>();

	function openChannel(context: NodeChannelContext, params: FleetCommandChannelParams): NodeChannelHandler {
		let closed = false;
		let ran = false;
		/** This channel started the run (a cancel channel names the run but does not own it). */
		let owns = false;
		/** The end, held while the link is down so the resume can report it (U2). */
		let pending: { output: FleetCommandOutputMessage; exitCode: number } | null = null;

		const reply = (requestId: unknown, outcome: Reply) => {
			if (typeof requestId !== 'string') return;
			context.sendJson({ requestId, ...outcome });
		};

		const deliverEnd = (): void => {
			if (!pending || closed) return;
			const exit = encodeFleetLinkExit(pending.exitCode) ?? encodeFleetLinkExit(1);
			if (!context.sendJson(pending.output as unknown as Record<string, unknown>)) return;
			if (exit) context.sendBinary(FLEET_LINK_FRAME_KINDS.EXIT, exit);
			pending = null;
			closed = true;
			context.close('normal');
		};

		async function run(requestId: unknown, request: FleetCommandRunParams): Promise<void> {
			const folder = await resolveCommandFolder({
				...(request.cwd ? { cwd: request.cwd } : {}),
				homedir: options.homedir,
				platform: options.platform,
				...(options.extraRoots ? { extraRoots: options.extraRoots } : {}),
				nodeName: options.nodeName,
				...(options.realpath ? { realpath: options.realpath } : {})
			});
			if (folder.error || !folder.cwd) {
				ran = false;
				reply(requestId, {
					error: makeFleetLinkError('invalid', folder.error?.hint ?? 'the folder is not allowed', {
						field: 'cwd'
					})
				});
				return;
			}
			if (closed) return;
			if (context.control.paused) {
				reply(requestId, { error: makeFleetLinkError('kill_switch', KILL_SWITCH_HINT) });
				return;
			}
			const shell = resolveLoginShell(options.platform, options.env);
			const env = buildNodeCheckEnv(null, options.env as NodeJS.ProcessEnv);
			let writer: CommandOutputWriter | null = null;
			if (options.store) {
				writer = await options.store.open(request.runId).catch((error: unknown) => {
					options.logger?.warn(`Commands: the output of a run cannot be kept: ${describe(error)}`);
					return null;
				});
			}
			const edges = new FleetCommandEdgeBuffer();
			let capped = false;
			let endReason: FleetCommandNodeEndReason | undefined;
			let handle: CommandRunHandle;
			try {
				handle = await start({
					command: request.command,
					cwd: folder.cwd,
					timeoutSec: request.timeoutSec,
					platform: options.platform,
					env,
					shell,
					onData: (chunk) => {
						edges.push(chunk);
						writer?.write(chunk);
						if (!closed) context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, chunk);
					},
					onCapped: (bytes) => {
						capped = true;
						if (!closed) context.sendJson({ type: 'command.truncated', runId: request.runId, bytes });
					},
					onTimeout: () => {
						endReason ??= 'timeout';
						if (!closed) {
							context.sendJson({
								type: 'command.timeout',
								runId: request.runId,
								timeoutSec: request.timeoutSec
							});
						}
					}
				});
			} catch (error) {
				// The shell could not start (spec U7): the first line of the error, never the command.
				await writer?.close();
				const firstLine = describe(error).split(/\r?\n/, 1)[0].slice(0, 300) || 'the shell could not start';
				reply(requestId, { error: makeFleetLinkError('operation_failed', firstLine) });
				return;
			}

			const entry: RunningCommand = {
				runId: request.runId,
				stop(reason) {
					endReason ??= reason;
					handle.stop();
				}
			};
			running.set(request.runId, entry);
			owns = true;
			const drainAtStart = context.control.drain?.receivedAt ?? null;
			const unsubscribe = context.control.onChange((state) => {
				if (state.paused) entry.stop('kill-switch');
				else if (state.drain && state.drain.receivedAt !== drainAtStart) entry.stop('drain');
			});
			// A pause that landed while the shell was starting.
			if (context.control.paused) entry.stop('kill-switch');

			reply(requestId, {
				result: { pid: handle.pid, startedAt: new Date(now()).toISOString(), shell: handle.shell }
			});

			const exit = await handle.done;
			unsubscribe();
			running.delete(request.runId);
			await writer?.close();
			void options.store?.prune();

			const exitCode =
				endReason === 'timeout'
					? FLEET_COMMAND_TIMEOUT_EXIT_CODE
					: endReason === 'cancelled-by-user'
						? FLEET_COMMAND_CANCEL_EXIT_CODE
						: endReason === 'kill-switch' || endReason === 'drain'
							? FLEET_COMMAND_STOPPED_EXIT_CODE
							: (exit.exitCode ?? 1);
			const snapshot = edges.snapshot();
			const output: FleetCommandOutputMessage = {
				type: 'command.output',
				runId: request.runId,
				head: snapshot.head,
				tail: snapshot.tail,
				truncated: snapshot.truncated,
				capped: capped || exit.capped,
				bytes: snapshot.bytes,
				exitCode,
				kept: writer !== null,
				...(endReason ? { reason: endReason } : {})
			};
			pending = { output, exitCode };
			deliverEnd();
		}

		/** Stream one run's kept output: the reply (its size), `DATA` chunks, `END`, then close. */
		async function read(requestId: unknown, runId: string): Promise<void> {
			let store: CommandOutputStore | null = options.store ?? null;
			if ((!store || !(await store.has(runId))) && options.findStore) {
				// FL-13: a schedule's run keeps its output in the schedule's own ring.
				const other = await options.findStore(runId).catch(() => null);
				if (other) store = other;
			}
			if (!store) {
				reply(requestId, {
					error: makeFleetLinkError('not_found', `${options.nodeName} keeps no full output of commands`)
				});
				return;
			}
			const stream = await store.read(runId);
			if (!stream) {
				reply(requestId, {
					error: makeFleetLinkError('not_found', `the full output of this run is no longer on ${options.nodeName}`)
				});
				return;
			}
			reply(requestId, { result: { bytes: await store.size(runId) } });
			for await (const raw of stream as AsyncIterable<Buffer>) {
				if (closed) {
					stream.destroy();
					return;
				}
				for (let offset = 0; offset < raw.byteLength; offset += FLEET_COMMAND_DATA_CHUNK_BYTES) {
					const piece = raw.subarray(offset, Math.min(raw.byteLength, offset + FLEET_COMMAND_DATA_CHUNK_BYTES));
					if (!context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array(piece))) {
						stream.destroy();
						if (!closed) {
							closed = true;
							context.close('unreachable', 'the link went away while the output was sent');
						}
						return;
					}
				}
			}
			if (closed) return;
			context.sendBinary(FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0));
			closed = true;
			context.close('normal');
		}

		return {
			resumeKey: `command-${params.runId}-${context.channel}`,
			onJson(message) {
				const requestId = message.requestId;
				const verb = message.type;
				const request =
					typeof message.params === 'object' && message.params !== null && !Array.isArray(message.params)
						? (message.params as Record<string, unknown>)
						: {};
				if (verb === 'command.run') {
					if (context.control.paused) {
						reply(requestId, { error: makeFleetLinkError('kill_switch', KILL_SWITCH_HINT) });
						return;
					}
					if (ran) {
						reply(requestId, { error: makeFleetLinkError('invalid', 'this channel already ran a command') });
						return;
					}
					const parsed = parseFleetCommandRunParams(request);
					if (!parsed || parsed.runId.toLowerCase() !== params.runId.toLowerCase()) {
						reply(requestId, { error: makeFleetLinkError('invalid', 'command parameters') });
						return;
					}
					if (running.has(parsed.runId)) {
						reply(requestId, { error: makeFleetLinkError('busy', 'this run is already running') });
						return;
					}
					ran = true;
					void run(requestId, parsed).catch((error: unknown) => {
						options.logger?.warn(`Commands: a run failed unexpectedly: ${describe(error)}`);
						reply(requestId, { error: makeFleetLinkError('operation_failed', 'the command could not run') });
					});
					return;
				}
				if (verb === 'command.read') {
					// "Open full output" (P2): the kept file of one run, streamed on this channel.
					const runId = typeof request.runId === 'string' ? request.runId : params.runId;
					void read(requestId, runId).catch((error: unknown) => {
						options.logger?.warn(`Commands: reading a run's output failed: ${describe(error)}`);
						if (!closed) {
							closed = true;
							context.close('operation_failed', 'the output could not be read');
						}
					});
					return;
				}
				if (verb === 'command.cancel') {
					const runId = typeof request.runId === 'string' ? request.runId : params.runId;
					const entry = running.get(runId);
					if (entry) entry.stop('cancelled-by-user');
					reply(requestId, { result: { cancelled: Boolean(entry) } });
					return;
				}
				reply(requestId, { error: makeFleetLinkError('invalid', 'unknown command request') });
			},
			onResume() {
				// The link came back: an end that happened while it was down is reported now (U2).
				deliverEnd();
			},
			onClose(reason) {
				closed = true;
				pending = null;
				// A link that did not come back leaves the command running (its output is kept here);
				// a channel the platform closed ends it.
				if (reason === 'resume_failed' || !owns) return;
				running.get(params.runId)?.stop('cancelled-by-user');
			}
		};
	}

	return {
		id: 'command',
		families: [
			{
				family: 'command',
				consent: 'manage',
				open(context) {
					const params = parseFleetCommandChannelParams(context.params);
					if (!params) return { ok: false, error: makeFleetLinkError('invalid', 'command channel parameters') };
					if (!options.consents.manage) {
						return {
							ok: false,
							error: makeFleetLinkError('consent_missing', fleetConsentMissingHint('manage', options.nodeName))
						};
					}
					return { ok: true, handler: openChannel(context, params) };
				}
			}
		]
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
