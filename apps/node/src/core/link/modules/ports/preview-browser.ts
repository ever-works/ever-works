import { homedir } from 'node:os';
import { join } from 'node:path';
import {
	COMPUTER_QUALITY_PRESETS,
	FLEET_LINK_FRAME_KINDS,
	FLEET_PORT_PREVIEW_LEAVE_GRACE_MS,
	FLEET_PORT_PREVIEW_MAX_MS,
	decodeComputerFrame,
	encodeComputerFrame,
	isComputerInputFrame,
	isFleetPortLoopbackUrl,
	makeFleetLinkError,
	type ComputerInputFrame,
	type ComputerQuality,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import { systemScheduler, type Scheduler } from '../../../heartbeat';
import type { Logger } from '../../../logger';
import type { CapturedPicture, CaptureRequest } from '../../../screen/capture-backend';
import {
	MachineVerbError,
	type NodeChannelContext,
	type NodeChannelOpenResult
} from '../registry';

/**
 * Servers and ports (FL-10, R-3, spec S4, FR-9 … FR-12, U8 … U10) — the
 * owner-level PREVIEW browser.
 *
 * **Open** on a machine without a Desktop source opens the port's address in
 * a browser profile that belongs to the machine's owner and to no Agent:
 * `~/.ever-works/preview-profile/browser` (env
 * `EVER_WORKS_NODE_PREVIEW_PROFILE_ROOT`), BESIDE `agent-profiles`, never
 * inside it, created lazily with the same owner-only protection (0700, an
 * ACL on Windows — fail closed). The browser is the probed one, headless,
 * driven through `PreviewPageSource`, whose only navigation is to a loopback
 * port.
 *
 * Its picture reaches the person through the link's `desktop` family
 * (`{ source: 'browser', profile: 'preview', viewId }`, CONTRACTS §3.3): a
 * channel per attached viewer, `FRAME` frames in the existing computer-frame
 * encoding, `INPUT` frames back (the gateway forwards input from a `driver`
 * only, and the platform mints the driver token for the opener only).
 *
 * One preview per node (FR-11): a second **Open** for another view while one
 * is live answers `busy` naming the holder. A preview ends 15 s after its last
 * viewer left, after 60 min in all, under the kill switch, and when the node
 * stops.
 */

export const PREVIEW_PROFILE_ROOT_ENV = 'EVER_WORKS_NODE_PREVIEW_PROFILE_ROOT';

/** `~/.ever-works/preview-profile` (R-3), or the env override. */
export function defaultPreviewProfileRoot(
	env: Record<string, string | undefined> = process.env,
	home = homedir()
): string {
	const override = env[PREVIEW_PROFILE_ROOT_ENV]?.trim();
	return override ? override : join(home, '.ever-works', 'preview-profile');
}

/** The browser user-data directory inside the preview root. */
export function previewBrowserDir(root: string): string {
	return join(root, 'browser');
}

/** What the preview needs of a browser page (`PreviewPageSource` in production). */
export interface PreviewSurface {
	navigate(url: string): Promise<void>;
	capture(request: CaptureRequest): Promise<CapturedPicture>;
	dispatchInput?(input: ComputerInputFrame): Promise<void>;
	stop(): Promise<void>;
}

export interface PreviewBrowserStarter {
	start(input: { profileDir: string; signal?: AbortSignal }): Promise<PreviewSurface>;
}

export interface PreviewBrowserManagerOptions {
	/** Null when the machine has no browser the node can drive (spec U10). */
	starter: PreviewBrowserStarter | null;
	root: string;
	mkdir: (path: string) => Promise<void>;
	/** Owner-only access for the freshly created directory (required on Windows). */
	restrictToOwner?: (path: string) => Promise<void> | void;
	nodeName: string;
	scheduler?: Scheduler;
	now?: () => number;
	logger?: Logger;
	/** Frames per second while someone watches. */
	fps?: number;
	/** How long the opener has to attach before an unwatched preview ends. */
	firstAttachMs?: number;
}

export type PreviewEndReason = 'left' | 'hard' | 'kill_switch' | 'replaced' | 'stopped' | 'failed';

interface PreviewViewer {
	push(picture: CapturedPicture): void;
	end(reason: PreviewEndReason): void;
}

interface PreviewSession {
	viewId: string;
	port: number;
	url: string;
	holder: string;
	surface: PreviewSurface;
	startedAt: number;
	viewers: Set<PreviewViewer>;
	hardTimer: unknown;
	leaveTimer: unknown;
	ended: boolean;
}

/** The view id a platform names a preview with: same alphabet as a viewer path target. */
const VIEW_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class PreviewBrowserManager {
	private session: PreviewSession | null = null;
	private starting: Promise<unknown> | null = null;
	private readonly scheduler: Scheduler;
	private readonly now: () => number;

	constructor(private readonly options: PreviewBrowserManagerOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
		this.now = options.now ?? (() => Date.now());
	}

	/** True when this machine can show a preview at all. */
	get available(): boolean {
		return this.options.starter !== null;
	}

	/** The live preview, if any (for `busy` answers and tests). */
	current(): { viewId: string; port: number; holder: string; endsAt: number } | null {
		const session = this.session;
		if (!session || session.ended) return null;
		return {
			viewId: session.viewId,
			port: session.port,
			holder: session.holder,
			endsAt: session.startedAt + FLEET_PORT_PREVIEW_MAX_MS
		};
	}

	/**
	 * Open `url` in the preview browser under `viewId`. The same view again
	 * navigates (a second port in the same pane); another view while one is
	 * live is refused `busy`. Throws {@link MachineVerbError}s.
	 */
	async open(input: { url: string; port: number; viewId: string; holder: string }): Promise<{ endsAt: number }> {
		if (!isFleetPortLoopbackUrl(input.url, input.port)) {
			throw new MachineVerbError(makeFleetLinkError('invalid', 'only a port on this machine can be opened'));
		}
		if (!VIEW_ID_PATTERN.test(input.viewId)) {
			throw new MachineVerbError(makeFleetLinkError('invalid', 'viewId'));
		}
		const starter = this.options.starter;
		if (!starter) {
			throw new MachineVerbError(
				makeFleetLinkError(
					'unsupported_on_node',
					`No browser found on ${this.options.nodeName} — install Chrome, Edge or Chromium there, or point the node at one (EVER_WORKS_NODE_BROWSER)`,
					{ target: 'preview-profile' }
				)
			);
		}
		if (this.starting) {
			throw new MachineVerbError(
				makeFleetLinkError('busy', `the preview browser on ${this.options.nodeName} is starting`, {
					target: 'preview-profile'
				})
			);
		}
		const live = this.current();
		if (live && live.viewId !== input.viewId) {
			throw new MachineVerbError(
				makeFleetLinkError('busy', `${live.holder} is previewing :${live.port} on ${this.options.nodeName}`, {
					holder: live.holder,
					port: live.port,
					viewId: live.viewId
				})
			);
		}
		if (live && this.session) {
			const session = this.session;
			await this.navigateOrFail(session.surface, input.url);
			session.port = input.port;
			session.url = input.url;
			return { endsAt: live.endsAt };
		}

		const run = (async () => {
			const profileDir = previewBrowserDir(this.options.root);
			await this.prepareProfile(profileDir);
			let surface: PreviewSurface;
			try {
				surface = await starter.start({ profileDir });
			} catch (error) {
				throw new MachineVerbError(
					makeFleetLinkError(
						'operation_failed',
						`the preview browser could not start: ${error instanceof Error ? error.message : String(error)}`.slice(
							0,
							300
						),
						{ target: 'preview-profile' }
					)
				);
			}
			try {
				await this.navigateOrFail(surface, input.url);
			} catch (error) {
				await surface.stop().catch(() => undefined);
				throw error;
			}
			const startedAt = this.now();
			const session: PreviewSession = {
				viewId: input.viewId,
				port: input.port,
				url: input.url,
				holder: input.holder,
				surface,
				startedAt,
				viewers: new Set(),
				hardTimer: null,
				leaveTimer: null,
				ended: false
			};
			session.hardTimer = this.scheduler.setTimeout(() => void this.end(session, 'hard'), FLEET_PORT_PREVIEW_MAX_MS);
			// The opener's pane attaches right after this answer; an unwatched preview does not linger.
			session.leaveTimer = this.scheduler.setTimeout(
				() => void this.end(session, 'left'),
				this.options.firstAttachMs ?? FLEET_PORT_PREVIEW_LEAVE_GRACE_MS * 2
			);
			this.session = session;
			return { endsAt: startedAt + FLEET_PORT_PREVIEW_MAX_MS };
		})();
		this.starting = run;
		try {
			return await run;
		} finally {
			this.starting = null;
		}
	}

	/** The kill switch, a node stop: end the preview now. */
	async endAll(reason: PreviewEndReason): Promise<void> {
		if (this.session) await this.end(this.session, reason);
	}

	/** A viewer for the live preview of `viewId`, or null when there is none. */
	attach(viewId: string, viewer: PreviewViewer): { surface: PreviewSurface; detach: () => void } | null {
		const session = this.session;
		if (!session || session.ended || session.viewId !== viewId) return null;
		session.viewers.add(viewer);
		if (session.leaveTimer !== null) {
			this.scheduler.clearTimeout(session.leaveTimer);
			session.leaveTimer = null;
		}
		return {
			surface: session.surface,
			detach: () => {
				session.viewers.delete(viewer);
				if (session.viewers.size === 0 && !session.ended && session.leaveTimer === null) {
					session.leaveTimer = this.scheduler.setTimeout(
						() => void this.end(session, 'left'),
						FLEET_PORT_PREVIEW_LEAVE_GRACE_MS
					);
				}
			}
		};
	}

	private async navigateOrFail(surface: PreviewSurface, url: string): Promise<void> {
		try {
			await surface.navigate(url);
		} catch (error) {
			throw new MachineVerbError(
				makeFleetLinkError(
					'operation_failed',
					(error instanceof Error ? error.message : String(error)).slice(0, 300),
					{ target: 'preview-profile' }
				)
			);
		}
	}

	private async prepareProfile(profileDir: string): Promise<void> {
		try {
			await this.options.mkdir(this.options.root);
			await this.options.mkdir(profileDir);
			await this.options.restrictToOwner?.(this.options.root);
		} catch (error) {
			throw new MachineVerbError(
				makeFleetLinkError(
					'operation_failed',
					`the preview profile could not be prepared: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						300
					),
					{ target: 'preview-profile' }
				)
			);
		}
	}

	private async end(session: PreviewSession, reason: PreviewEndReason): Promise<void> {
		if (session.ended) return;
		session.ended = true;
		if (session.hardTimer !== null) this.scheduler.clearTimeout(session.hardTimer);
		if (session.leaveTimer !== null) this.scheduler.clearTimeout(session.leaveTimer);
		for (const viewer of [...session.viewers]) {
			try {
				viewer.end(reason);
			} catch {
				// a viewer's failure is its own
			}
		}
		session.viewers.clear();
		if (this.session === session) this.session = null;
		try {
			await session.surface.stop();
		} catch (error) {
			this.options.logger?.warn(
				`The preview browser did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}

// ─── The `desktop` channel's preview source ────────────────────────────────

const encoder = new TextEncoder();

/** Consecutive failed pictures before the channel gives up. */
const MAX_FAILED_PICTURES = 3;
/** An unchanged picture is re-sent at least this often (a fresh keyframe). */
const KEYFRAME_MS = 5_000;

function closeReasonFor(reason: PreviewEndReason): 'normal' | 'kill_switch' | 'operation_failed' {
	if (reason === 'kill_switch') return 'kill_switch';
	if (reason === 'failed') return 'operation_failed';
	return 'normal';
}

/**
 * Open one `desktop` channel on the live preview (`params.viewId`). Refused
 * `not_found` when no preview of that view is live. Pictures are taken at
 * `fps` while the channel is open (never while the link cannot take them),
 * an unchanged picture is skipped until the keyframe interval, and three
 * failed pictures in a row end the channel.
 */
export function openPreviewChannel(
	context: NodeChannelContext,
	manager: PreviewBrowserManager,
	options: { fps?: number; scheduler?: Scheduler; now?: () => number } = {}
): NodeChannelOpenResult {
	const viewId = typeof context.params.viewId === 'string' ? context.params.viewId : '';
	const scheduler = options.scheduler ?? systemScheduler;
	const now = options.now ?? (() => Date.now());
	const fps = Math.min(15, Math.max(1, options.fps ?? 4));
	let quality: ComputerQuality =
		context.params.quality === 'sharp' || context.params.quality === 'steady' ? context.params.quality : 'smooth';
	let closed = false;
	let timer: unknown = null;
	let busy = false;
	let failures = 0;
	let seq = 0;
	let lastData: string | null = null;
	let lastSentAt = 0;
	let forceNext = true;

	const viewer: PreviewViewer = {
		push: () => undefined,
		end: (reason) => {
			if (closed) return;
			stop();
			context.close(closeReasonFor(reason), reason === 'hard' ? 'the preview reached its 60-minute limit' : undefined);
		}
	};
	const attached = manager.attach(viewId, viewer);
	if (!attached) {
		return {
			ok: false,
			error: makeFleetLinkError('not_found', 'no preview is open for this view — open the port again')
		};
	}

	const stop = (): void => {
		if (closed) return;
		closed = true;
		if (timer !== null) scheduler.clearTimeout(timer);
		timer = null;
		attached.detach();
	};

	const tick = async (): Promise<void> => {
		timer = null;
		if (closed) return;
		if (!busy) {
			busy = true;
			try {
				const preset = COMPUTER_QUALITY_PRESETS[quality];
				const picture = await attached.surface.capture({ width: preset.width, quality: preset.q });
				failures = 0;
				const at = now();
				if (forceNext || picture.data !== lastData || at - lastSentAt >= KEYFRAME_MS) {
					const encoded = encodeComputerFrame({
						kind: 'frame',
						seq: seq++,
						keyframe: true,
						width: picture.width,
						height: picture.height,
						mime: picture.mime,
						data: picture.data
					});
					if (encoded && context.sendBinary(FLEET_LINK_FRAME_KINDS.FRAME, encoder.encode(encoded))) {
						lastData = picture.data;
						lastSentAt = at;
						forceNext = false;
					}
				}
			} catch (error) {
				failures++;
				if (failures >= MAX_FAILED_PICTURES) {
					context.logger?.warn(
						`The preview picture failed ${failures} times: ${error instanceof Error ? error.message : String(error)}`
					);
					stop();
					context.close('operation_failed', 'the preview browser stopped answering');
					return;
				}
			} finally {
				busy = false;
			}
		}
		if (!closed) timer = scheduler.setTimeout(() => void tick(), Math.round(1000 / fps));
	};
	timer = scheduler.setTimeout(() => void tick(), 0);

	return {
		ok: true,
		handler: {
			onJson: (message) => {
				if (message.type === 'desktop.refresh') forceNext = true;
				else if (
					message.type === 'desktop.quality' &&
					(message.quality === 'sharp' || message.quality === 'smooth' || message.quality === 'steady')
				) {
					quality = message.quality;
					forceNext = true;
				}
			},
			onBinary: (kind: FleetLinkFrameKind, payload: Uint8Array) => {
				if (kind !== FLEET_LINK_FRAME_KINDS.INPUT || closed) return;
				// The kill switch pauses input; the gateway already refused a watcher's.
				if (context.control.paused) return;
				const frame = decodeComputerFrame(payload);
				if (!frame || !isComputerInputFrame(frame) || !attached.surface.dispatchInput) return;
				forceNext = true;
				attached.surface.dispatchInput(frame).catch(() => undefined);
			},
			onClose: () => stop()
		}
	};
}
