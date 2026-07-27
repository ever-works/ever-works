import { describeSelf, type CapabilityEnvironment, type CommandRunner } from './capabilities';
import { FleetClient, type FetchLike } from './fleet-client';
import { FleetJobClient } from './job-client';
import { HeartbeatLoop, type Scheduler } from './heartbeat';
import { WorkerLoop } from './worker-loop';
import { runAcceptanceChecksJob } from './executors/acceptance-checks';
import { runAgentTaskJob } from './executors/agent-task';
import { runBrowserCheckJob } from './executors/browser-check';
import type { Logger } from './logger';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	type FleetEnrollableNodeKind,
	type FleetNodeKind,
	type FleetNodeView,
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
	kind: FleetEnrollableNodeKind;
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
	/**
	 * The worker host, present when this node is configured to EXECUTE
	 * work (`workerEnabled`). Absent means the node only reports liveness
	 * and capabilities — the pre-M4 behaviour, preserved so a machine can
	 * be enrolled purely for visibility.
	 */
	worker?: WorkerLoop;
	jobClient?: FleetJobClient;
}

export interface CreateNodeRuntimeOptions {
	/**
	 * Run the lease → execute → report loop alongside the heartbeat.
	 * Off by default: enrolling a machine and letting it run the owner's
	 * commands are two different consents, and the second is opt-in.
	 */
	workerEnabled?: boolean;
	/** Max jobs in flight on this node. */
	concurrency?: number;
	leaseTtlSec?: number;
	idlePollMs?: number;
	/**
	 * Directory `agent-task` steps run in when the job itself carries no
	 * `workspacePath`. Absent lets the executor fall back to the node
	 * service's own working directory.
	 */
	agentTaskWorkspacePath?: string;

	/**
	 * Start the worker drained. The node still heartbeats (so it stays
	 * observable in Fleet) but leases nothing until it is resumed —
	 * how `ever-works-node pause` survives a service restart.
	 */
	startPaused?: boolean;
}

/**
 * Build the heartbeat runtime for an already-enrolled node. The capability
 * description is re-detected on every beat, so installing Docker or Git on a
 * running node shows up in Fleet without a restart.
 */
export function createNodeRuntime(config: NodeConfig, io: NodeIo, options: CreateNodeRuntimeOptions = {}): NodeRuntime {
	io.logger.protect(config.secret);

	const userAgent = io.userAgent ?? `ever-works-node/${io.version}`;
	const client = new FleetClient({
		apiUrl: config.apiUrl,
		fetchFn: io.fetchFn,
		logger: io.logger,
		userAgent
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

	const runtime: NodeRuntime = { client, loop: new HeartbeatLoop(loopOptions) };

	if (options.workerEnabled) {
		const jobClient = new FleetJobClient({
			apiUrl: config.apiUrl,
			nodeId: config.nodeId,
			secret: config.secret,
			fetchFn: io.fetchFn,
			logger: io.logger,
			userAgent
		});
		const worker = new WorkerLoop({
			client: jobClient,
			logger: io.logger,
			...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
			...(options.leaseTtlSec !== undefined ? { leaseTtlSec: options.leaseTtlSec } : {}),
			...(options.idlePollMs !== undefined ? { idlePollMs: options.idlePollMs } : {}),
			...(options.startPaused !== undefined ? { startPaused: options.startPaused } : {}),
			...(io.scheduler ? { scheduler: io.scheduler } : {})
		});
		// The executor seam: a job kind is one more `register` call
		// against the same protocol — no new endpoint, no new credential.
		worker.register('acceptance-checks', (job) => runAcceptanceChecksJob(job));
		// The general kind. Without it an enrolled machine could only ever
		// score a gate; with it a Task's run can actually EXECUTE here when
		// the owner's resolved job runtime is the fleet. Same seam, same
		// protocol, same credential — exactly as the header above promised.
		worker.register('agent-task', (job) =>
			runAgentTaskJob(job, {
				...(options.agentTaskWorkspacePath !== undefined
					? { defaultWorkspacePath: options.agentTaskWorkspacePath }
					: {})
			})
		);
		// `browser-check` is registered ONLY when this machine actually
		// resolved a browser executable (audit A26). A node advertising
		// the `browser` capability with no executor behind it would fail
		// every job that tag invited, so the tag and the executor are
		// switched on by the SAME fact.
		if (io.environment.browserPath) {
			const browserPath = io.environment.browserPath;
			worker.register('browser-check', (job) =>
				runBrowserCheckJob(job, {
					resolveBrowser: () => browserPath,
					hasDisplay: io.environment.hasDisplay
				})
			);
		}
		runtime.worker = worker;
		runtime.jobClient = jobClient;
	}

	return runtime;
}

/**
 * Tell the platform to drain (or resume) this node, using the node's own
 * heartbeat credential.
 *
 * Returns the refreshed node view so the caller can report the status
 * the platform actually settled on rather than the one it asked for.
 */
export async function pauseNode(config: NodeConfig, io: NodeIo, paused: boolean): Promise<FleetNodeView> {
	io.logger.protect(config.secret);
	const client = new FleetClient({
		apiUrl: config.apiUrl,
		fetchFn: io.fetchFn,
		logger: io.logger,
		userAgent: io.userAgent ?? `ever-works-node/${io.version}`
	});
	const result = await client.pause({ nodeId: config.nodeId, secret: config.secret, paused });
	return result.node;
}

/**
 * Retire this node's registration on the platform.
 *
 * The local credential is erased by the CALLER (`clearConfig`), always,
 * even when this call fails — an operator decommissioning a machine
 * must not be left with a live secret on it because the API was
 * unreachable.
 */
export async function unenrollNode(config: NodeConfig, io: NodeIo): Promise<void> {
	io.logger.protect(config.secret);
	const client = new FleetClient({
		apiUrl: config.apiUrl,
		fetchFn: io.fetchFn,
		logger: io.logger,
		userAgent: io.userAgent ?? `ever-works-node/${io.version}`
	});
	await client.unenroll({ nodeId: config.nodeId, secret: config.secret });
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
