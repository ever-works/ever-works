import {
	clampFleetSessionSize,
	FLEET_LINK_FRAME_KINDS,
	FLEET_SESSION_END_GRACE_MS,
	FLEET_SESSION_REPLAY_LINES,
	FLEET_SESSIONS_CAPABILITY,
	fleetConsentMissingHint,
	fleetConsentSatisfies,
	fleetSessionConsentFor,
	isFleetDaemonSessionId,
	isFleetSessionEndedReason,
	isFleetSessionLinkVerb,
	makeFleetLinkError,
	parseFleetSessionAck,
	parseFleetSessionAnswerParams,
	parseFleetSessionChannelParams,
	parseFleetSessionNotice,
	parseFleetSessionStartParams,
	type FleetConsents,
	type FleetLinkError,
	type FleetSessionAnswerParams,
	type FleetLinkExtensionMessage,
	type FleetSessionChannelParams,
	type FleetSessionEventMessage,
	type FleetSessionListEntry
} from '@ever-works/contracts';
import type { Logger } from '../../logger';
import { DaemonRequestError, type DaemonAttachStream } from '../../sessions/daemon-client';
import {
	DAEMON_FRAME,
	decodeDaemonJson,
	type DaemonSessionInfo,
	type DaemonWatchEvent
} from '../../sessions/daemon/daemon-protocol';
import type { SessionDaemonSupervisor } from '../../sessions/daemon-supervisor';
import { composeOwnerSession, type OwnerSessionLaunchInput } from '../../sessions/owner-session-launcher';
import type { NodeChannelContext, NodeChannelHandler, NodeLinkControlState, NodeModule } from './registry';

/**
 * Fleet node link — the `session` family (FL-04, CONTRACTS §3.3, R-5, R-24,
 * R-40): the node's half of sessions on computers.
 *
 * A thin bridge between the platform's channels and the node's session
 * daemon, which owns every process:
 *
 *  - **Channels.** One per attached viewer (`session.attach`, then terminal
 *    frames both ways: the daemon's `DATA`/`EXIT`/notices go out on the
 *    channel, a driver's `DATA`/`RESIZE` come in), and one short-lived one per
 *    control request (`session.start`, `.end`, `.rename`, `.restart`,
 *    `.resize`, `.input`, `.screen`). A viewer channel never forwards input,
 *    whatever the platform sends.
 *  - **Consent, on this machine** (never trusting the platform's check):
 *    owner sessions need `--manage`, Agent sessions `--work` — checked
 *    against the channel's `kind` before it opens and again against the
 *    daemon's own record of the session.
 *  - **Facts on channel 0.** After every `link.ready`: `session.list` (every
 *    session the daemon holds and its health), then `session.event`
 *    `exited`/`lost` with the last screen for each ended one; live:
 *    `started`, `title`, `activity`, `exited`. The platform's `session.ack`
 *    lets the daemon forget an ended session.
 *  - **Kill switch** (`link.pause`): every session's input is blocked, every
 *    process keeps running; `link.resume` lifts it with no reconnect.
 *    **Drain** (`link.drain`): every live owner session is warned, then ended
 *    after the grace with reason `drain` (Agent sessions end with their Runs).
 *
 * The `sessions` tag is advertised exactly while the daemon answers health
 * and can host a terminal (FR-10).
 */

export interface SessionModuleOptions {
	supervisor: SessionDaemonSupervisor;
	consents: FleetConsents;
	nodeName: string;
	/** Everything the owner launcher needs from this machine, minus the per-session values. */
	launch: Omit<OwnerSessionLaunchInput, 'sessionId' | 'provider' | 'cwd' | 'firstMessage' | 'consents' | 'nodeName'>;
	logger?: Logger;
	/** How long after start a Windows `.cmd` CLI's first message is typed. */
	typeAfterStartMs?: number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/**
	 * FL-05: told what a DRIVER typed into a session (the status pipeline reads
	 * a Ctrl-C in a running turn as `interrupted`, U15). Facts only — the bytes
	 * are not kept. Never able to fail the input.
	 */
	onInput?: (sessionId: string, data: string | Uint8Array) => void;
	/**
	 * FL-05 P2: answer what a session asks (`session.answer`) — the status
	 * pipeline checks the key is current and types what the CLI expects.
	 * Absent: the verb answers `unsupported_on_node`.
	 */
	answer?: (
		sessionId: string,
		params: FleetSessionAnswerParams
	) => Promise<{ ok: true } | { ok: false; error: FleetLinkError }>;
}

/** What the runtime binds once the link exists. */
export interface SessionModuleLink {
	readonly control: NodeLinkControlState;
	getState(): { phase: string; linkGeneration: number | null };
	onChange(listener: (state: { phase: string; linkGeneration: number | null }) => void): () => void;
	sendControl(message: FleetLinkExtensionMessage): boolean;
}

export interface SessionModule extends NodeModule {
	/** Bind the link: channel-0 facts, the kill switch and drain. Idempotent per link. */
	bindLink(link: SessionModuleLink): void;
	/** Stop timers and listeners (shutdown). The daemon and its sessions keep running. */
	dispose(): void;
}

type Reply = { result: unknown } | { error: FleetLinkError };

const isInfoList = (value: unknown): value is { sessions: DaemonSessionInfo[] } =>
	typeof value === 'object' && value !== null && Array.isArray((value as { sessions?: unknown }).sessions);

function asLinkError(error: unknown, fallbackHint: string): FleetLinkError {
	if (error instanceof DaemonRequestError) return makeFleetLinkError(error.code, error.hint);
	return makeFleetLinkError('operation_failed', fallbackHint);
}

export function createSessionModule(options: SessionModuleOptions): SessionModule {
	const { supervisor, consents, nodeName } = options;
	const setTimer =
		options.setTimer ??
		((callback: () => void, ms: number) => {
			const timer = setTimeout(callback, ms);
			timer.unref?.();
			return timer;
		});
	const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
	let link: SessionModuleLink | null = null;
	const unsubscribes: Array<() => void> = [];
	const drainTimers = new Set<unknown>();
	let lastReconciledGeneration: number | null = null;
	let lastDrainAt: number | null = null;

	const send = (message: FleetLinkExtensionMessage): boolean => link?.sendControl(message) ?? false;

	const daemonRefusal = (): FleetLinkError =>
		makeFleetLinkError(
			'unsupported_on_node',
			`the session daemon is not running on ${nodeName}${
				supervisor.report().reason ? ` — ${supervisor.report().reason}` : ''
			}`
		);

	// ─── Channel 0: facts ──────────────────────────────────────────────────

	async function screenOf(sessionId: string): Promise<string | undefined> {
		try {
			const screen = await supervisor.request<{ text: string }>('screen', {
				sessionId,
				lines: FLEET_SESSION_REPLAY_LINES
			});
			return typeof screen?.text === 'string' ? screen.text : undefined;
		} catch {
			return undefined;
		}
	}

	/** `session.list` plus the ended sessions' last screens (FR-9, FR-11, U13). */
	async function reconcile(): Promise<void> {
		if (!link || link.getState().phase !== 'connected') return;
		let sessions: DaemonSessionInfo[] = [];
		if (supervisor.healthy || supervisor.report().state === 'failed') {
			try {
				const listed = await supervisor.request('list');
				if (isInfoList(listed)) sessions = listed.sessions;
			} catch {
				sessions = [];
			}
		}
		const entries: FleetSessionListEntry[] = sessions.map((info) => ({
			sessionId: info.id,
			kind: info.kind,
			provider: info.provider,
			cwd: info.cwd,
			title: info.title,
			startedAt: info.startedAt,
			alive: info.alive,
			exitCode: info.exitCode,
			cols: info.cols,
			rows: info.rows,
			viewers: info.viewers,
			drivers: info.drivers
		}));
		send({ type: 'session.list', sessions: entries, daemon: supervisor.report() });
		for (const info of sessions) {
			if (info.alive) continue;
			const screen = await screenOf(info.id);
			const event: FleetSessionEventMessage = {
				type: 'session.event',
				sessionId: info.id,
				event: info.lost ? 'lost' : 'exited',
				exitCode: info.exitCode,
				...(screen !== undefined ? { screen } : {}),
				...(info.endReason ? { reason: info.endReason } : {})
			};
			send(event as unknown as FleetLinkExtensionMessage);
		}
	}

	async function forwardEvent(event: DaemonWatchEvent): Promise<void> {
		if (!link || link.getState().phase !== 'connected') return;
		const base = { type: 'session.event', sessionId: event.id, at: event.at } as const;
		switch (event.event) {
			case 'started':
				send({ ...base, event: 'started' });
				return;
			case 'activity':
				send({ ...base, event: 'activity' });
				return;
			case 'title':
				send({ ...base, event: 'title', title: event.title });
				return;
			case 'exited': {
				const screen = await screenOf(event.id);
				send({
					...base,
					event: 'exited',
					exitCode: event.exitCode,
					...(screen !== undefined ? { screen } : {}),
					...(event.reason ? { reason: event.reason } : {})
				});
				return;
			}
			default:
				return;
		}
	}

	// ─── Kill switch and drain (R-24) ──────────────────────────────────────

	function applyPause(paused: boolean): void {
		supervisor
			.request('block-input', paused ? { on: true, reason: 'the fleet stop' } : { on: false })
			.catch((error: unknown) =>
				options.logger?.warn(`Sessions: could not ${paused ? 'block' : 'unblock'} input: ${describe(error)}`)
			);
	}

	async function drain(graceSec: number): Promise<void> {
		let sessions: DaemonSessionInfo[] = [];
		try {
			const listed = await supervisor.request('list');
			if (isInfoList(listed)) sessions = listed.sessions;
		} catch {
			return;
		}
		for (const info of sessions) {
			// Agent sessions end as their Runs are cancelled (FR-38); owner sessions are ours to end.
			if (!info.alive || info.kind !== 'owner') continue;
			await supervisor.request('warn', { sessionId: info.id, seconds: graceSec }).catch(() => undefined);
			const timer = setTimer(
				() => {
					drainTimers.delete(timer);
					void supervisor
						.request('end', { sessionId: info.id, reason: 'drain', graceMs: FLEET_SESSION_END_GRACE_MS })
						.catch(() => undefined);
				},
				Math.max(0, graceSec) * 1000
			);
			drainTimers.add(timer);
		}
	}

	// ─── A channel ─────────────────────────────────────────────────────────

	function openChannel(context: NodeChannelContext, params: FleetSessionChannelParams): NodeChannelHandler {
		let stream: DaemonAttachStream | null = null;
		let attaching = false;
		let closed = false;
		const isDriver = params.mode === 'driver';
		const observeInput = (data: string | Uint8Array) => {
			try {
				options.onInput?.(params.sessionId, data);
			} catch {
				// An observer never fails the input.
			}
		};

		const reply = (requestId: unknown, outcome: Reply) => {
			if (typeof requestId !== 'string') return;
			context.sendJson({ requestId, ...outcome });
		};

		const bindStream = (next: DaemonAttachStream) => {
			stream = next;
			next.onFrame((kind, payload) => {
				switch (kind) {
					case DAEMON_FRAME.DATA:
						context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, payload);
						return;
					case DAEMON_FRAME.EXIT:
						context.sendBinary(FLEET_LINK_FRAME_KINDS.EXIT, payload);
						return;
					case DAEMON_FRAME.JSON: {
						const notice = parseFleetSessionNotice(decodeDaemonJson(payload));
						if (notice) context.sendJson(notice as unknown as Record<string, unknown>);
						return;
					}
					default:
						return;
				}
			});
			next.onClose(() => {
				if (stream !== next) return;
				stream = null;
				if (!closed) context.close('normal');
			});
		};

		async function attach(requestId: unknown, request: Record<string, unknown>): Promise<void> {
			if (attaching || stream) {
				reply(requestId, { error: makeFleetLinkError('invalid', 'this channel is already attached') });
				return;
			}
			attaching = true;
			try {
				const size = isDriver ? clampFleetSessionSize(request.cols, request.rows) : null;
				const next = await supervisor.attach({
					sessionId: params.sessionId,
					mode: params.mode,
					...(size ? { cols: size.cols, rows: size.rows } : {})
				});
				if (closed) {
					next.close();
					return;
				}
				// The reply first: the replay that follows it is the channel's first output.
				reply(requestId, { result: next.info });
				bindStream(next);
			} catch (error) {
				reply(requestId, { error: asLinkError(error, 'could not attach to the session') });
			} finally {
				attaching = false;
			}
		}

		async function start(requestId: unknown, request: Record<string, unknown>, verb: 'start' | 'restart') {
			const parsed = parseFleetSessionStartParams(request);
			if (!parsed) {
				reply(requestId, { error: makeFleetLinkError('invalid', 'session start parameters') });
				return;
			}
			if (params.kind && params.kind !== parsed.kind) {
				reply(requestId, {
					error: makeFleetLinkError('invalid', 'the session kind does not match the channel')
				});
				return;
			}
			if (parsed.kind === 'agent') {
				// Agent sessions start as durable `agent-session` jobs on the work lane (R-28), never here.
				reply(requestId, {
					error: makeFleetLinkError('invalid', 'Agent sessions are started as jobs, not on the link')
				});
				return;
			}
			const composed = await composeOwnerSession({
				...options.launch,
				sessionId: params.sessionId,
				provider: parsed.provider,
				cwd: parsed.cwd,
				...(parsed.firstMessage ? { firstMessage: parsed.firstMessage } : {}),
				consents,
				nodeName
			});
			if (!composed.ok) {
				reply(requestId, { error: makeFleetLinkError(composed.error.code, composed.error.hint) });
				return;
			}
			try {
				// Shell inside a container (FL-09 P3, FR-35): the same owner shell session,
				// running `docker exec -it` (the Docker CLI, never its socket) instead of the
				// login shell. The container and shell were validated by the params parser.
				const command = parsed.container
					? [
							'docker',
							'exec',
							'-it',
							'-e',
							'TERM=xterm-256color',
							parsed.container.container,
							parsed.container.shell
						]
					: composed.launch.command;
				const started = await supervisor.request<{ pid: number | null }>('start', {
					sessionId: params.sessionId,
					kind: parsed.kind,
					provider: parsed.provider,
					command,
					cwd: composed.launch.cwd,
					env: composed.launch.env,
					cols: parsed.cols,
					rows: parsed.rows,
					title: parsed.title,
					startedBy: parsed.startedBy
				});
				reply(requestId, { result: { daemonSessionId: params.sessionId, pid: started?.pid ?? null } });
				const typed = parsed.container ? undefined : composed.launch.typeAfterStart;
				if (typed) {
					setTimer(() => {
						void supervisor
							.request('input', { sessionId: params.sessionId, data: `${typed}\r` })
							.catch(() => undefined);
					}, options.typeAfterStartMs ?? 1_500);
				}
			} catch (error) {
				reply(requestId, {
					error: asLinkError(
						error,
						verb === 'restart' ? 'the session could not restart' : 'the session could not start'
					)
				});
			}
		}

		async function control(requestId: unknown, op: string, payload: Record<string, unknown>, fallback: string) {
			try {
				reply(requestId, { result: await supervisor.request(op, { sessionId: params.sessionId, ...payload }) });
			} catch (error) {
				reply(requestId, { error: asLinkError(error, fallback) });
			}
		}

		return {
			resumeKey: `session-${params.sessionId}-${context.channel}`,
			onJson(message) {
				const requestId = message.requestId;
				const verb = message.type;
				const request =
					typeof message.params === 'object' && message.params !== null && !Array.isArray(message.params)
						? (message.params as Record<string, unknown>)
						: {};
				if (!isFleetSessionLinkVerb(verb)) {
					reply(requestId, { error: makeFleetLinkError('invalid', 'unknown session request') });
					return;
				}
				// The kill switch refuses every state-changing request (R-24); reading the screen and
				// attaching to watch stay allowed so the stop banner can be shown.
				if (context.control.paused && verb !== 'session.screen' && verb !== 'session.attach') {
					reply(requestId, { error: makeFleetLinkError('kill_switch', 'clear it under Settings → Fleet') });
					return;
				}
				switch (verb) {
					case 'session.attach':
						void attach(requestId, request);
						return;
					case 'session.start':
						void start(requestId, request, 'start');
						return;
					case 'session.restart':
						void start(requestId, request, 'restart');
						return;
					case 'session.input': {
						if (!isDriver) {
							reply(requestId, {
								error: makeFleetLinkError('permission_denied', 'viewers cannot type into a session')
							});
							return;
						}
						if (typeof request.data !== 'string' || request.data.length > 64 * 1024) {
							reply(requestId, { error: makeFleetLinkError('invalid', 'data') });
							return;
						}
						observeInput(request.data);
						// FL-06 (T-14): an action prompt carries `source: 'action'` and its id — logged here,
						// typed byte-for-byte like any other input (the agent's own permission prompts stay).
						if (request.source === 'action' && typeof request.actionId === 'string') {
							options.logger?.info?.(
								`Session ${params.sessionId}: action ${request.actionId.slice(0, 40)} typed (${request.data.length} chars)`
							);
						}
						void control(requestId, 'input', { data: request.data }, 'could not send the input');
						return;
					}
					case 'session.resize': {
						if (!isDriver) {
							reply(requestId, {
								error: makeFleetLinkError('permission_denied', 'viewers cannot resize a session')
							});
							return;
						}
						const size = clampFleetSessionSize(request.cols, request.rows);
						if (stream) {
							stream.sendResize(size.cols, size.rows);
							reply(requestId, { result: size });
						} else void control(requestId, 'resize', size, 'could not resize the session');
						return;
					}
					case 'session.end': {
						const reason = isFleetSessionEndedReason(request.reason) ? request.reason : 'user';
						const graceMs =
							typeof request.graceMs === 'number'
								? Math.min(60_000, Math.max(0, request.graceMs))
								: FLEET_SESSION_END_GRACE_MS;
						void control(requestId, 'end', { reason, graceMs }, 'could not end the session');
						return;
					}
					case 'session.rename': {
						if (typeof request.title !== 'string') {
							reply(requestId, { error: makeFleetLinkError('invalid', 'title') });
							return;
						}
						void control(requestId, 'rename', { title: request.title }, 'could not rename the session');
						return;
					}
					case 'session.screen':
						void control(
							requestId,
							'screen',
							{ lines: typeof request.lines === 'number' ? request.lines : 40 },
							'could not read the screen'
						);
						return;
					case 'session.answer': {
						// FL-05 P2: answer what the session asks — a driver's request (the
						// platform's answer route), never a watcher's.
						if (!isDriver) {
							reply(requestId, {
								error: makeFleetLinkError('permission_denied', 'viewers cannot answer a session')
							});
							return;
						}
						const answerParams = parseFleetSessionAnswerParams(request);
						if (!answerParams) {
							reply(requestId, { error: makeFleetLinkError('invalid', 'answer') });
							return;
						}
						if (!options.answer) {
							reply(requestId, {
								error: makeFleetLinkError('unsupported_on_node', 'this node cannot answer session prompts yet')
							});
							return;
						}
						void options
							.answer(params.sessionId, answerParams)
							.then((outcome) =>
								reply(requestId, outcome.ok ? { result: { answered: true } } : { error: outcome.error })
							)
							.catch(() =>
								reply(requestId, {
									error: makeFleetLinkError('operation_failed', 'the answer could not be typed')
								})
							);
						return;
					}
					default:
						reply(requestId, {
							error: makeFleetLinkError('unsupported_on_node', 'unknown session request')
						});
						return;
				}
			},
			onBinary(kind, payload) {
				// Only a driver's channel carries keystrokes and sizes; a viewer's are dropped here.
				if (!isDriver || !stream) return;
				if (kind === FLEET_LINK_FRAME_KINDS.DATA) {
					if (!context.control.paused) {
						stream.sendInput(payload);
						observeInput(payload);
					}
					return;
				}
				if (kind === FLEET_LINK_FRAME_KINDS.RESIZE && payload.byteLength === 4) {
					const view = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
					const size = clampFleetSessionSize(view.readUInt16BE(0), view.readUInt16BE(2));
					stream.sendResize(size.cols, size.rows);
				}
			},
			onResume() {
				// The link came back: re-attach for a fresh replay, telling the viewer to clear first.
				const previous = stream;
				if (!previous) return;
				stream = null;
				previous.close();
				context.sendJson({ type: 'session.notice', notice: 'replay' });
				void supervisor
					.attach({ sessionId: params.sessionId, mode: params.mode })
					.then((next) => {
						if (closed) next.close();
						else bindStream(next);
					})
					.catch(() => context.close('resume_failed'));
			},
			onClose() {
				closed = true;
				const current = stream;
				stream = null;
				current?.close();
			}
		};
	}

	const module: SessionModule = {
		id: 'session',
		tags: () => (supervisor.healthy ? [FLEET_SESSIONS_CAPABILITY] : []),
		families: [
			{
				family: 'session',
				// R-5: the channel's kind names its consent; without one, either will do here and
				// the daemon's own record decides at open.
				consent: (params) => {
					const parsed = parseFleetSessionChannelParams(params);
					return parsed?.kind ? fleetSessionConsentFor(parsed.kind) : 'work-or-manage';
				},
				async open(context) {
					const params = parseFleetSessionChannelParams(context.params);
					if (!params)
						return { ok: false, error: makeFleetLinkError('invalid', 'session channel parameters') };
					if (!supervisor.healthy) return { ok: false, error: daemonRefusal() };
					if (!params.kind) {
						// No kind named: the daemon's record decides which consent applies.
						try {
							const listed = await supervisor.request('list');
							const known = isInfoList(listed)
								? listed.sessions.find((info) => info.id === params.sessionId)
								: undefined;
							if (known) {
								const needed = fleetSessionConsentFor(known.kind);
								if (!fleetConsentSatisfies(consents, needed)) {
									return {
										ok: false,
										error: makeFleetLinkError(
											'consent_missing',
											fleetConsentMissingHint(needed, nodeName)
										)
									};
								}
							}
						} catch {
							return { ok: false, error: daemonRefusal() };
						}
					}
					return { ok: true, handler: openChannel(context, params) };
				}
			}
		],
		controlHandlers: {
			'session.ack': (message) => {
				const ack = parseFleetSessionAck(message);
				const ids = (ack?.sessionIds ?? []).filter(isFleetDaemonSessionId);
				if (ids.length === 0) return;
				void supervisor.request('ack-ended', { sessionIds: ids }).catch(() => undefined);
			}
		},
		bindLink(next) {
			if (link === next) return;
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			link = next;
			lastReconciledGeneration = null;
			unsubscribes.push(
				next.onChange((state) => {
					if (state.phase !== 'connected' || state.linkGeneration === null) return;
					if (state.linkGeneration === lastReconciledGeneration) return;
					lastReconciledGeneration = state.linkGeneration;
					void reconcile();
				}),
				next.control.onChange((state) => {
					applyPause(state.paused);
					if (state.drain && state.drain.receivedAt !== lastDrainAt) {
						lastDrainAt = state.drain.receivedAt;
						void drain(state.drain.graceSec);
					}
				}),
				supervisor.onEvent((event) => void forwardEvent(event)),
				supervisor.onConnected(() => {
					// A fresh daemon connection: carry the pause over, and re-report everything.
					if (next.control.paused) applyPause(true);
					void reconcile();
				})
			);
		},
		dispose() {
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			for (const timer of drainTimers) clearTimer(timer);
			drainTimers.clear();
			link = null;
		}
	};
	return module;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
