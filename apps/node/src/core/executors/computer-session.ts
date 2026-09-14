import type { ITerminalStreamPlugin } from '@ever-works/plugin';
import {
	isComputerChannel,
	isComputerQuality,
	makeComputerErrorFrame,
	type ComputerChannel,
	type ComputerCloseReason,
	type ComputerNodeToServerFrame,
	type ComputerQuality,
	type FleetJobView
} from '@ever-works/contracts';
import type { FleetJobClient } from '../job-client';
import type { Logger } from '../logger';
import { LEASE_TERMINATION_SAFETY_MS } from '../worker-loop';
import { createAgentControlMarker } from '../screen/agent-control-marker';
import type { AgentProfileFs, AgentProfileManager } from '../screen/agent-profile';
import type { CaptureBackend } from '../screen/capture-backend';
import { CapturePump } from '../screen/capture-pump';
import type { WebSocketFactory } from '../screen/cdp-connection';
import { ComputerFrameOutbox } from '../screen/frame-outbox';
import { ComputerInputInjector } from '../screen/input-injector';
import { openNodeLeg, type NodeLeg } from '../screen/node-leg';
import { startNodeTerminalChannel, type NodeTerminalChannel } from '../screen/terminal-channel';

/**
 * The `computer-session` executor — an owner's live view of the machine an
 * Agent works on.
 *
 * Leased only by this machine's attended live-view lane (the platform pins
 * the job to the node the owner chose and requires `attended`), it:
 *
 *   1. resolves the watched Agent's OWN profile directory here (creating it
 *      on first use, replacing it when the owner reset it on the platform);
 *   2. starts the requested channels — the screen through the machine's
 *      selected capture backend, the terminal through the node's
 *      `terminal-stream` provider — both publishing through ONE outbox that
 *      secret-scans and batches every frame before it leaves the machine;
 *   3. opens this machine's own OUTBOUND socket leg so the owner's quality
 *      and refresh requests reach the capture — and, while a person holds
 *      control of the view, their input reaches the Agent's browser through
 *      the input injector, with the Agent told it is paused;
 *   4. reports the view's lifecycle every few seconds, which is how a stop
 *      switch or an owner's "End session" reaches the machine;
 *   5. ends cleanly: when the platform ends the view it just stops; when
 *      THIS machine is draining or shutting down it publishes an `end`
 *      frame (`node-unavailable`) inside the lease-termination budget, so
 *      the owner sees why the picture stopped rather than a frozen one.
 *
 * Watching never alters a Run: it only reads what the Agent's browser shows.
 * Only a person who took control drives that browser, and only until they
 * give control back.
 */

export const COMPUTER_SESSION_HEARTBEAT_MS = 4000;

export class ComputerSessionPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ComputerSessionPayloadError';
	}
}

export interface ComputerSessionPayload {
	sessionId: string;
	agentId: string;
	nodeId: string;
	profileKey: string;
	channels: ComputerChannel[];
	quality: ComputerQuality;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the wire payload; refuses rather than repairs, and refuses a view pinned to another machine. */
export function normalizeComputerSessionPayload(raw: unknown, nodeId: string): ComputerSessionPayload {
	if (!raw || typeof raw !== 'object') throw new ComputerSessionPayloadError('Live view payload is missing');
	const payload = raw as Record<string, unknown>;
	const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
	const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
	if (!UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(agentId)) {
		throw new ComputerSessionPayloadError('Live view payload has no valid session or Agent');
	}
	if (payload.nodeId !== nodeId) {
		throw new ComputerSessionPayloadError('Live view was pinned to a different machine');
	}
	const profileKey = typeof payload.profileKey === 'string' ? payload.profileKey : '';
	const channels = Array.isArray(payload.channels)
		? [...new Set(payload.channels.filter((channel): channel is ComputerChannel => isComputerChannel(channel)))]
		: [];
	if (channels.length === 0) throw new ComputerSessionPayloadError('Live view payload names no channel');
	return {
		sessionId,
		agentId,
		nodeId,
		profileKey,
		channels,
		quality: isComputerQuality(payload.quality) ? payload.quality : 'sharp'
	};
}

export interface ComputerSessionExecutorDeps {
	nodeId: string;
	/** The platform origin this node talks to. */
	apiUrl: string;
	client: Pick<
		FleetJobClient,
		'publishComputerFrames' | 'computerSessionHeartbeat' | 'mintComputerWorkerToken' | 'reportComputerProfile'
	>;
	profiles: Pick<AgentProfileManager, 'ensure' | 'diskBytes'>;
	/** The selected capture backend, or null when this machine cannot show a screen. */
	captureBackend: CaptureBackend | null;
	/** The node's `terminal-stream` provider, or null when it cannot host a shell. */
	terminalHost: ITerminalStreamPlugin | null;
	/** The inbound leg's socket factory; null skips the leg (quality/refresh then wait for the next view). */
	webSocketFactory: WebSocketFactory | null;
	logger?: Logger;
	heartbeatIntervalMs?: number;
	platform?: string;
	/** The environment a terminal channel's shell is built from (scrubbed there); defaults to this process's. */
	parentEnv?: NodeJS.ProcessEnv;
	/**
	 * Where the "a person has control" marker is written in the Agent's own
	 * profile directory. Optional: without it control still injects input,
	 * but the Agent is not told it is paused.
	 */
	profileFs?: Pick<AgentProfileFs, 'writeTextFile' | 'rm'>;
}

export interface ComputerSessionResult extends Record<string, unknown> {
	sessionId: string;
	channels: ComputerChannel[];
	endedBy: 'platform' | 'node';
	closeReason: ComputerCloseReason | null;
	bytesOut: number;
	captureRestarts: number;
}

export async function runComputerSessionJob(
	job: FleetJobView,
	deps: ComputerSessionExecutorDeps,
	signal: AbortSignal
): Promise<ComputerSessionResult> {
	const payload = normalizeComputerSessionPayload(job.payload, deps.nodeId);
	const { sessionId } = payload;
	const logger = deps.logger;

	let platformEnded = false;
	let platformReason: ComputerCloseReason | null = null;
	let wake: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		wake = resolve;
	});
	const endByPlatform = (reason: ComputerCloseReason | null): void => {
		if (platformEnded) return;
		platformEnded = true;
		platformReason = reason;
		wake();
	};
	const onAbort = (): void => wake();
	signal.addEventListener('abort', onAbort, { once: true });

	const outbox = new ComputerFrameOutbox({
		sessionId,
		publisher: deps.client,
		onEnded: endByPlatform,
		...(logger ? { logger } : {})
	});
	const banner = (message: string): void => {
		outbox.push(makeComputerErrorFrame(message) as ComputerNodeToServerFrame);
	};

	let pump: CapturePump | null = null;
	let terminal: NodeTerminalChannel | null = null;
	let leg: NodeLeg | null = null;
	let injector: ComputerInputInjector | null = null;
	let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
	let fatal: ComputerCloseReason | null = null;

	try {
		const profile = await deps.profiles.ensure(payload.nodeId, payload.agentId, payload.profileKey);

		if (payload.channels.includes('screen')) {
			if (!deps.captureBackend) {
				banner('This computer cannot show a screen: no capture is available here.');
			} else {
				pump = new CapturePump({
					backend: deps.captureBackend,
					profileDir: profile.browserDir,
					quality: payload.quality,
					outbox,
					...(logger ? { logger } : {})
				});
				try {
					await pump.start();
				} catch (error) {
					pump = null;
					banner(`The Agent's browser could not be opened on this computer: ${describe(error)}`);
				}
			}
		}
		if (payload.channels.includes('terminal')) {
			if (!deps.terminalHost) {
				banner('This computer cannot serve a terminal right now.');
			} else {
				try {
					terminal = await startNodeTerminalChannel({
						host: deps.terminalHost,
						sessionId,
						cwd: profile.filesDir,
						publish: (frame) => outbox.push({ kind: 'terminal', frame }),
						...(deps.platform ? { platform: deps.platform } : {}),
						...(deps.parentEnv ? { parentEnv: deps.parentEnv } : {})
					});
				} catch (error) {
					banner(`A terminal could not be started on this computer: ${describe(error)}`);
				}
			}
		}
		if (!pump && !terminal) {
			// Nothing to show: say so (the banners above) and end the view.
			fatal = 'error';
		} else {
			void reportProfile(deps, payload, pump);
			if (deps.webSocketFactory && pump) {
				const capture = pump;
				const marker = deps.profileFs
					? createAgentControlMarker({ profileDir: profile.dir, fs: deps.profileFs })
					: null;
				const inputs = new ComputerInputInjector({
					target: () => capture.captureSource,
					...(marker ? { onControlChange: (controlled: boolean) => marker.set(controlled) } : {}),
					...(logger ? { logger } : {})
				});
				injector = inputs;
				leg = openNodeLeg({
					apiUrl: deps.apiUrl,
					mintToken: () => deps.client.mintComputerWorkerToken(sessionId),
					factory: deps.webSocketFactory,
					onRequest: (frame) => {
						if (frame.kind === 'refresh') capture.refresh();
						else capture.setQuality(frame.quality);
					},
					onMode: (mode) => inputs.setControlled(mode === 'controlling'),
					onInput: (frame) => void inputs.inject(frame),
					...(logger ? { logger } : {})
				});
			}
			const beat = async (): Promise<void> => {
				try {
					const answer = await deps.client.computerSessionHeartbeat(sessionId);
					if (answer.ended) endByPlatform(answer.closeReason);
				} catch (error) {
					if ((error as { kind?: string })?.kind === 'unauthorized') endByPlatform(null);
				}
				if (!platformEnded && !signal.aborted) {
					heartbeatTimer = setTimeout(
						() => void beat(),
						deps.heartbeatIntervalMs ?? COMPUTER_SESSION_HEARTBEAT_MS
					);
					heartbeatTimer.unref?.();
				}
			};
			void beat();
			if (!signal.aborted && !platformEnded) await finished;
		}
	} catch (error) {
		logger?.warn(`Live view ${sessionId} failed: ${describe(error)}`);
		banner('The live view stopped because of an error on this computer.');
		fatal = 'error';
	} finally {
		signal.removeEventListener('abort', onAbort);
		if (heartbeatTimer) clearTimeout(heartbeatTimer);
		leg?.close();
		// The view is over: whatever control it held is over too, and the
		// Agent is told it may use its browser again.
		injector?.setControlled(false);
		await Promise.allSettled([injector?.idle(), pump?.stop(), terminal?.stop()]);
	}

	const nodeReason: ComputerCloseReason | null = platformEnded ? null : (fatal ?? 'node-unavailable');
	if (nodeReason) {
		// This machine ended the view (draining, shutting down, or nothing to
		// show): pin the reason for every viewer, inside the lease budget.
		await outbox.close({ kind: 'end', reason: nodeReason }, LEASE_TERMINATION_SAFETY_MS / 2);
		try {
			await deps.client.computerSessionHeartbeat(sessionId, { status: 'ended', closeReason: nodeReason });
		} catch {
			// The end frame already told the platform; the reaper is the floor.
		}
	} else {
		await outbox.close(undefined, 1000);
	}
	return {
		sessionId,
		channels: payload.channels,
		endedBy: platformEnded ? 'platform' : 'node',
		closeReason: platformEnded ? platformReason : nodeReason,
		bytesOut: outbox.bytesOut(),
		captureRestarts: pump?.restartCount ?? 0
	};
}

async function reportProfile(
	deps: ComputerSessionExecutorDeps,
	payload: ComputerSessionPayload,
	pump: CapturePump | null
): Promise<void> {
	try {
		const [signedInSiteCount, diskBytes] = await Promise.all([
			pump?.captureSource?.countSignedInSites?.() ?? Promise.resolve(null),
			deps.profiles.diskBytes(payload.nodeId, payload.agentId)
		]);
		await deps.client.reportComputerProfile(payload.sessionId, {
			profileKey: payload.profileKey,
			signedInSiteCount: signedInSiteCount ?? 0,
			diskBytes
		});
	} catch {
		// The isolation panel's numbers are a courtesy; the view does not depend on them.
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
