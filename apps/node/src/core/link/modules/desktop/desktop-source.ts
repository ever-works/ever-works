import {
	decodeComputerFrame,
	encodeComputerFrame,
	fleetDesktopControlReasonHint,
	fleetDesktopReasonHint,
	FLEET_DESKTOP_MESSAGES,
	FLEET_LINK_FRAME_KINDS,
	isComputerInputFrame,
	isComputerShortcutBlocked,
	isFleetDesktopQuality,
	isFleetDisplayId,
	makeFleetLinkError,
	readFleetDesktopSourceParams,
	type ComputerQuality,
	type FleetDesktopInputRefusedCode,
	type FleetLinkError,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import type { Logger } from '../../../logger';
import type {
	DesktopHelperHost,
	DesktopHelperStream,
	DesktopStreamEnd,
	DesktopStreamRefusal
} from '../../../screen/desktop-helper-backend';
import type { DesktopSourceOpener } from '../desktop';
import type { NodeChannelContext, NodeChannelOpenResult, NodeModule } from '../registry';

/**
 * Desktop view & control (FL-07, plan §6.4, CONTRACTS §3.3) — the Desktop
 * source of FL-02's `desktop` family: `channel.open { source: 'desktop',
 * viewId, display?, quality? }` starts a helper stream of one display and the
 * channel carries it.
 *
 *   node → platform  `desktop.started { display, displays, fellBack, quality }` (once, after `channel.ready`)
 *                    `FRAME` (20) keyframes in the existing computer-frame encoding
 *                    `TILES` (23) changed regions (the contracts payload, re-checked)
 *                    `desktop.stats` once a second — numbers only
 *                    `desktop.displayChanged { displays, fallback? }` on a hot-plug
 *   platform → node  `desktop.quality`, `desktop.refresh`, `desktop.displays`, `desktop.setDisplay`
 *
 * The family's consent (`--attend`) was checked by the link before this runs.
 * Watching is read-only: every `INPUT` frame is dropped here, and the kill
 * switch (`link.pause`) refuses the open and ends a live stream.
 *
 * Control (P2): a channel opened `mode: 'controlling'` — the platform mints that
 * only for the view holding the computer's control lock, and FL-02's gateway
 * forwards `INPUT` only from that view's `driver` socket — forwards input to the
 * helper, after refusing the blocked shortcuts here first (the helper refuses
 * them again). The owner's on-machine permission (`helper control allow`) is
 * checked again before the helper starts; withdrawing it, the kill switch or
 * the channel closing releases every key and button (FR-39) and ends control.
 * While a person controls the desktop, the node says so on its own console:
 * who, and how to stop it.
 *
 *   node → platform  `desktop.inputRefused { code }` — an input the machine did
 *                    not take, at most one a second, a code only
 * A frame the link cannot take right now is dropped and a fresh keyframe asked
 * for, so a slow link resynchronises instead of queueing pictures.
 */

/** The quality a view opens at when the platform names none (AW-11's default preset). */
export const DESKTOP_DEFAULT_QUALITY: ComputerQuality = 'smooth';
/** `desktop.stats` cadence. */
export const DESKTOP_STATS_EVERY_MS = 1_000;

const textEncoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** The typed refusal for an open the host could not serve. */
export function desktopRefusalError(refusal: DesktopStreamRefusal, nodeName: string): FleetLinkError {
	switch (refusal.kind) {
		case 'reason':
			return makeFleetLinkError('unsupported_on_node', fleetDesktopReasonHint(refusal.reason, nodeName), {
				reason: refusal.reason
			});
		case 'limit':
			return makeFleetLinkError('limit_exceeded', `${nodeName} is already showing its desktop twice; close one view`, {
				limit: 'views-per-computer'
			});
		case 'control':
			return makeFleetLinkError('unsupported_on_node', fleetDesktopControlReasonHint(refusal.reason, nodeName), {
				reason: refusal.reason
			});
		case 'crashing':
			return makeFleetLinkError(
				'operation_failed',
				`the screen helper on ${nodeName} keeps stopping; try again in a minute (ever-works-node helper status)`
			);
		case 'failed':
			return makeFleetLinkError('operation_failed', refusal.message.split(/\r?\n/, 1)[0].slice(0, 300));
	}
}

function endReason(reason: DesktopStreamEnd, nodeName: string): { code: FleetLinkError['code'] | 'normal'; hint?: string } {
	switch (reason) {
		case 'revoked':
			return { code: 'unsupported_on_node', hint: `the screen helper's approval on ${nodeName} was revoked` };
		case 'kill-switch':
			return { code: 'kill_switch', hint: 'clear it under Settings → Fleet' };
		case 'helper-exited':
			return { code: 'operation_failed', hint: `the screen helper on ${nodeName} stopped` };
		case 'stopped':
			return { code: 'normal' };
	}
}

/** At most one `desktop.inputRefused` a second goes back to a controller who keeps trying. */
export const DESKTOP_INPUT_REFUSED_EVERY_MS = 1_000;

export interface DesktopSourceOptions {
	host: DesktopHelperHost;
	/** P2: where the node says, on its own console, that someone is controlling this computer. */
	logger?: Logger;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	setRepeat?: (callback: () => void, ms: number) => unknown;
	clearRepeat?: (handle: unknown) => void;
}

/** The `desktop` family's Desktop-source opener (`createDesktopModule(…, { desktop })`). */
export function createDesktopSourceOpener(options: DesktopSourceOptions): DesktopSourceOpener {
	const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const setRepeat =
		options.setRepeat ??
		((callback, ms) => {
			const handle = setInterval(callback, ms);
			handle.unref?.();
			return handle;
		});
	const clearRepeat = options.clearRepeat ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
	const now = options.now ?? (() => Date.now());

	return async (context: NodeChannelContext): Promise<NodeChannelOpenResult> => {
		const params = readFleetDesktopSourceParams(context.params as Record<string, unknown>);
		if (!params) {
			return { ok: false, error: makeFleetLinkError('invalid', 'a desktop view needs a view id') };
		}
		if (context.control.paused) {
			return { ok: false, error: makeFleetLinkError('kill_switch', 'clear it under Settings → Fleet') };
		}
		let quality: ComputerQuality = params.quality ?? DESKTOP_DEFAULT_QUALITY;
		// P2: only a grant to the control holder opens `controlling`; anything else watches.
		const controlling = params.mode === 'controlling';
		let controlLive = controlling;
		let picture: { width: number; height: number } | null = null;
		let lastRefusedAt = -Infinity;
		let ready = false;
		let closed = false;
		let seq = 0;
		let bytesOut = 0;
		let framesThisSecond = 0;
		let tilesThisSecond = 0;
		let resyncWanted = false;
		let stream: DesktopHelperStream | null = null;
		let statsTimer: unknown = null;
		let unwatch: (() => void) | null = null;

		const say = (line: string): void => {
			try {
				options.logger?.warn(line);
			} catch {
				// the console is a courtesy; control never depends on it
			}
		};
		const endControl = (why: string): void => {
			if (!controlLive) return;
			controlLive = false;
			// FR-39: every key and button let go before anything else.
			stream?.releaseAll();
			say(`Desktop control of this computer ended (${why}).`);
		};
		const finish = (): void => {
			if (closed) return;
			endControl('the view closed');
			closed = true;
			if (statsTimer !== null) clearRepeat(statsTimer);
			statsTimer = null;
			unwatch?.();
			unwatch = null;
			stream?.stop();
		};
		const refuseInput = (code: FleetDesktopInputRefusedCode): void => {
			const at = now();
			if (!ready || closed || at - lastRefusedAt < DESKTOP_INPUT_REFUSED_EVERY_MS) return;
			lastRefusedAt = at;
			context.sendJson({ type: FLEET_DESKTOP_MESSAGES.inputRefused, code });
		};
		const send = (kind: FleetLinkFrameKind, payload: Uint8Array): void => {
			if (!ready || closed) return;
			if (context.sendBinary(kind, payload)) bytesOut += payload.byteLength;
			else resyncWanted = true;
		};

		const opened = await options.host.openStream(
			{ display: params.display ?? null, quality, ...(controlling ? { controlling: true } : {}) },
			{
				onFrame: (frame) => {
					picture = { width: frame.width, height: frame.height };
					const encoded = encodeComputerFrame({
						kind: 'frame',
						seq: seq++,
						keyframe: true,
						width: frame.width,
						height: frame.height,
						mime: 'image/jpeg',
						data: base64(frame.jpeg)
					});
					if (!encoded) return;
					framesThisSecond++;
					send(FLEET_LINK_FRAME_KINDS.FRAME, textEncoder.encode(encoded));
				},
				onTiles: (payload) => {
					tilesThisSecond++;
					send(FLEET_LINK_FRAME_KINDS.TILES, payload);
				},
				onDisplays: (displays) => {
					if (!ready || closed) return;
					const message: Record<string, unknown> = {
						type: FLEET_DESKTOP_MESSAGES.displayChanged,
						displays: displays.displays
					};
					if (displays.fallback) message.fallback = displays.fallback;
					context.sendJson(message);
				},
				onError: (error) => {
					if (closed) return;
					if (error.code === 'capture-failed') {
						finish();
						context.close('operation_failed', error.message || 'the desktop could not be captured');
					}
				},
				onInputResult: (result) => refuseInput(result.code),
				onControlRevoked: (reason) => {
					if (closed) return;
					endControl('control was withdrawn on this computer');
					finish();
					context.close('unsupported_on_node', fleetDesktopControlReasonHint(reason, context.nodeName));
				},
				onEnded: (reason) => {
					if (closed) return;
					const end = endReason(reason, context.nodeName);
					controlLive = false;
					closed = true;
					if (statsTimer !== null) clearRepeat(statsTimer);
					unwatch?.();
					context.close(end.code, end.hint);
				}
			}
		);
		if (!opened.ok) return { ok: false, error: desktopRefusalError(opened.refusal, context.nodeName) };
		stream = opened.stream;
		if (controlling) {
			// Visible on the machine (the node runs in the person's session, decision 5).
			say(
				`Desktop control: ${params.controlledBy ?? 'a person in Ever Works'} is now controlling this computer's mouse and keyboard. ` +
					'To stop it at once: ever-works-node helper control deny (or the fleet stop switch).'
			);
		}

		// `channel.ready` goes out when this open resolves; the first message follows it.
		setTimer(() => {
			if (closed) return;
			ready = true;
			context.sendJson({
				type: FLEET_DESKTOP_MESSAGES.started,
				display: stream?.started.display ?? null,
				displays: stream?.started.displays ?? [],
				fellBack: stream?.started.fellBack === true,
				quality,
				mode: controlling ? 'controlling' : 'watching'
			});
			// Anything the helper published before `ready` was dropped: start from a keyframe.
			stream?.refresh();
		}, 0);
		statsTimer = setRepeat(() => {
			if (!ready || closed) return;
			context.sendJson({
				type: FLEET_DESKTOP_MESSAGES.stats,
				quality,
				effectiveQuality: quality,
				fps: framesThisSecond,
				backlog: resyncWanted ? 1 : 0,
				bytesOut,
				tilesPerSec: tilesThisSecond
			});
			framesThisSecond = 0;
			tilesThisSecond = 0;
			if (resyncWanted) {
				resyncWanted = false;
				stream?.refresh();
			}
		}, DESKTOP_STATS_EVERY_MS);
		// The kill switch ends a live view at once (R-24, FR-32).
		unwatch = context.control.onChange((state) => {
			if (!state.paused || closed) return;
			endControl('the fleet stop switch is on');
			finish();
			context.close('kill_switch', 'clear it under Settings → Fleet');
		});

		const reply = (requestId: unknown, body: Record<string, unknown>): void => {
			if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 64) return;
			context.sendJson({ requestId, ...body });
		};

		return {
			ok: true,
			handler: {
				onJson: (message) => {
					if (closed || !stream) return;
					const live = stream;
					switch (message.type) {
						case FLEET_DESKTOP_MESSAGES.quality: {
							if (!isFleetDesktopQuality(message.quality)) {
								reply(message.requestId, { error: makeFleetLinkError('invalid', 'quality') });
								return;
							}
							quality = message.quality;
							live.setQuality(quality);
							reply(message.requestId, { ok: true });
							return;
						}
						case FLEET_DESKTOP_MESSAGES.refresh:
							live.refresh();
							reply(message.requestId, { ok: true });
							return;
						case FLEET_DESKTOP_MESSAGES.displays:
							void live.listDisplays().then((displays) => {
								if (closed) return;
								context.sendJson({
									type: FLEET_DESKTOP_MESSAGES.displays,
									...(typeof message.requestId === 'string' ? { requestId: message.requestId } : {}),
									displays
								});
							});
							return;
						case FLEET_DESKTOP_MESSAGES.setDisplay: {
							if (!isFleetDisplayId(message.display)) {
								reply(message.requestId, { error: makeFleetLinkError('invalid', 'display') });
								return;
							}
							void live.setDisplay(message.display).then((answer) => {
								if (closed) return;
								if (!answer.ok) {
									reply(message.requestId, {
										error: makeFleetLinkError(
											'unsupported_on_node',
											`${context.nodeName} has no display "${String(message.display)}"`,
											{ display: message.display }
										)
									});
									return;
								}
								context.sendJson({
									type: FLEET_DESKTOP_MESSAGES.started,
									display: answer.started.display,
									displays: answer.started.displays,
									fellBack: false,
									quality
								});
								reply(message.requestId, { ok: true });
							});
							return;
						}
						default:
							return;
					}
				},
				onBinary: (kind, payload) => {
					// Watching is read-only: no INPUT (or any other binary frame) reaches this machine.
					if (kind !== FLEET_LINK_FRAME_KINDS.INPUT || closed || !stream) return;
					if (!controlling) return;
					if (!controlLive) {
						refuseInput('not-controlling');
						return;
					}
					// The kill switch pauses input before it ends the view.
					if (context.control.paused) return;
					const frame = decodeComputerFrame(payload);
					if (!frame || !isComputerInputFrame(frame)) return;
					if (frame.kind === 'key' && isComputerShortcutBlocked(frame)) {
						refuseInput('blocked-shortcut');
						return;
					}
					if (!picture) return; // nothing on screen to aim at yet
					stream.input(frame, picture);
				},
				onClose: () => finish()
			}
		};
	};
}

/**
 * The tags the helper contributes (`helper:screen`, `screen:desktop`), re-read
 * on every beat from the host's last verification — a module of its own, so
 * FL-02's `desktop` family module stays the only claimant of the family.
 */
export function createDesktopHelperTagsModule(host: Pick<DesktopHelperHost, 'tags'>): NodeModule {
	return { id: 'desktop-helper', tags: () => host.tags() };
}
