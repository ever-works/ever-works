import { describeSelf, type CapabilityEnvironment, type CommandRunner } from './capabilities';
import { FleetClient, type FetchLike } from './fleet-client';
import { HeartbeatLoop, type Scheduler } from './heartbeat';
import type { Logger } from './logger';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	type FleetNodeKind,
	type NodeConfig
} from './types';

/**
 * Composition root shared by `apps/node`'s CLI and `apps/desktop-node`'s
 * Electron main process. Enrollment and the heartbeat runtime are wired here
 * exactly once so the two shells cannot drift apart (PRD §3.3: "shares one
 * core with apps/desktop-node so enrollment and heartbeat are written once").
 */

export interface NodeIo {
	fetchFn: FetchLike;
	runner: CommandRunner;
	environment: CapabilityEnvironment;
	logger: Logger;
	/** Reported as the node's `version` (capped to 32 chars server-side). */
	version: string;
	/** Sent as `User-Agent` — required by the production API edge. */
	userAgent?: string;
	scheduler?: Scheduler;
	now?: () => number;
}

export interface EnrollNodeOptions extends NodeIo {
	apiUrl: string;
	token: string;
	kind: FleetNodeKind;
	/** Local display label. Optional — defaults to the platform-assigned name. */
	name?: string;
	heartbeatIntervalMs?: number;
}

/** Clamp an operator-supplied heartbeat interval into the supported range. */
export function clampHeartbeatInterval(intervalMs: number | undefined): number {
	if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) {
		return DEFAULT_HEARTBEAT_INTERVAL_MS;
	}
	return Math.min(Math.max(Math.round(intervalMs), MIN_HEARTBEAT_INTERVAL_MS), MAX_HEARTBEAT_INTERVAL_MS);
}

/**
 * Detect capabilities, consume the one-time token, and return a ready-to-save
 * {@link NodeConfig}.
 *
 * NOTE on `name`: the platform assigns the node's name when the enrollment
 * token is issued in the Fleet settings page — `POST /api/fleet/enroll` takes
 * no name. The `name` here is therefore a LOCAL label only; the authoritative
 * name is whatever Fleet shows, and we default to it.
 */
export async function enrollNode(options: EnrollNodeOptions): Promise<NodeConfig> {
	const { logger } = options;
	logger.protect(options.token);

	const client = new FleetClient({
		apiUrl: options.apiUrl,
		fetchFn: options.fetchFn,
		logger,
		userAgent: options.userAgent ?? `ever-works-node/${options.version}`
	});

	const description = await describeSelf(options.runner, options.environment, options.version);
	logger.info(`Enrolling with ${client.baseUrl} as ${description.platform} [${description.capabilities.join(', ')}]`);

	const result = await client.enroll({ token: options.token, ...description });
	logger.protect(result.secret);

	const config: NodeConfig = {
		apiUrl: client.baseUrl,
		nodeId: result.nodeId,
		secret: result.secret,
		kind: options.kind,
		capabilities: description.capabilities,
		heartbeatIntervalMs: clampHeartbeatInterval(options.heartbeatIntervalMs),
		enrolledAt: new Date(options.now ? options.now() : Date.now()).toISOString()
	};
	const label = options.name?.trim() || result.node.name;
	if (label) {
		config.name = label;
	}

	logger.info(`Enrolled as node ${result.nodeId} ("${config.name ?? 'unnamed'}")`);
	return config;
}

export interface NodeRuntime {
	client: FleetClient;
	loop: HeartbeatLoop;
}

/**
 * Build the heartbeat runtime for an already-enrolled node. The capability
 * description is re-detected on every beat, so installing Docker or Git on a
 * running node shows up in Fleet without a restart.
 */
export function createNodeRuntime(config: NodeConfig, io: NodeIo): NodeRuntime {
	io.logger.protect(config.secret);

	const client = new FleetClient({
		apiUrl: config.apiUrl,
		fetchFn: io.fetchFn,
		logger: io.logger,
		userAgent: io.userAgent ?? `ever-works-node/${io.version}`
	});

	const loopOptions = {
		client,
		nodeId: config.nodeId,
		secret: config.secret,
		describe: () => describeSelf(io.runner, io.environment, io.version),
		intervalMs: clampHeartbeatInterval(config.heartbeatIntervalMs),
		logger: io.logger,
		...(io.scheduler ? { scheduler: io.scheduler } : {}),
		...(io.now ? { now: io.now } : {})
	};

	return { client, loop: new HeartbeatLoop(loopOptions) };
}

/** Process-signal abstraction so shutdown wiring is testable. */
export interface SignalSource {
	on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
}

/**
 * Wire graceful shutdown on SIGINT/SIGTERM. The handler runs at most once —
 * a second Ctrl-C while the first shutdown is still draining must not kick off
 * a concurrent teardown.
 */
export function installShutdownHandlers(signals: SignalSource, shutdown: () => Promise<void> | void): void {
	let shuttingDown = false;
	const handler = (): void => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		void shutdown();
	};
	signals.on('SIGINT', handler);
	signals.on('SIGTERM', handler);
}
