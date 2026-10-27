import {
	encodeComputerFrame,
	fleetDesktopReasonHint,
	FLEET_DESKTOP_MESSAGES,
	FLEET_LINK_FRAME_KINDS,
	isFleetDesktopQuality,
	isFleetDisplayId,
	makeFleetLinkError,
	readFleetDesktopSourceParams,
	type ComputerQuality,
	type FleetLinkError,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
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
 * Watching is read-only: every `INPUT` frame is dropped here (control is P2),
 * and the kill switch (`link.pause`) refuses the open and ends a live stream.
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

export interface DesktopSourceOptions {
	host: DesktopHelperHost;
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

	return async (context: NodeChannelContext): Promise<NodeChannelOpenResult> => {
		const params = readFleetDesktopSourceParams(context.params as Record<string, unknown>);
		if (!params) {
			return { ok: false, error: makeFleetLinkError('invalid', 'a desktop view needs a view id') };
		}
		if (context.control.paused) {
			return { ok: false, error: makeFleetLinkError('kill_switch', 'clear it under Settings → Fleet') };
		}
		let quality: ComputerQuality = params.quality ?? DESKTOP_DEFAULT_QUALITY;
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

		const finish = (): void => {
			if (closed) return;
			closed = true;
			if (statsTimer !== null) clearRepeat(statsTimer);
			statsTimer = null;
			unwatch?.();
			unwatch = null;
			stream?.stop();
		};
		const send = (kind: FleetLinkFrameKind, payload: Uint8Array): void => {
			if (!ready || closed) return;
			if (context.sendBinary(kind, payload)) bytesOut += payload.byteLength;
			else resyncWanted = true;
		};

		const opened = await options.host.openStream(
			{ display: params.display ?? null, quality },
			{
				onFrame: (frame) => {
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
				onEnded: (reason) => {
					if (closed) return;
					const end = endReason(reason, context.nodeName);
					closed = true;
					if (statsTimer !== null) clearRepeat(statsTimer);
					unwatch?.();
					context.close(end.code, end.hint);
				}
			}
		);
		if (!opened.ok) return { ok: false, error: desktopRefusalError(opened.refusal, context.nodeName) };
		stream = opened.stream;

		// `channel.ready` goes out when this open resolves; the first message follows it.
		setTimer(() => {
			if (closed) return;
			ready = true;
			context.sendJson({
				type: FLEET_DESKTOP_MESSAGES.started,
				display: stream?.started.display ?? null,
				displays: stream?.started.displays ?? [],
				fellBack: stream?.started.fellBack === true,
				quality
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
							// `desktop.mode` and input arrive with control (P2).
							return;
					}
				},
				// Watching is read-only (P1): no INPUT (or any other binary frame) reaches this machine.
				onBinary: () => undefined,
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
