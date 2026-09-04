import { PlatformAuthClient } from './auth-client';
import {
	describeSelf,
	type CapabilityEnvironment,
	type CommandRunner,
	type SelfDescriptionTelemetry
} from './capabilities';
import { detectAgentCliVersion, detectDiskFreeBytes, type DiskProbeIo } from './telemetry-probe';
import { FleetClient, type FetchLike } from './fleet-client';
import { FleetJobClient } from './job-client';
import { HeartbeatLoop, type Scheduler } from './heartbeat';
import type { ResourceProbe } from './resource-limits';
import { WorkerLoop } from './worker-loop';
import type { WorkerSafetyGate } from './worker-safety-store';
import { runAcceptanceChecksJob } from './executors/acceptance-checks';
import { runAgentTaskJob } from './executors/agent-task';
import { runBrowserCheckJob } from './executors/browser-check';
import type { ModelCliPaths } from './executors/model-cli';
import { defaultFleetTaskWorkspaceRoot, FleetTaskWorkspaceProvisioner } from './workspaces/fleet-task-workspace';
import type { Logger } from './logger';
import {
	clampResourceLimits,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	type FleetEnrollableNodeKind,
	type FleetNodeView,
	type NodeConfig,
	type NodeResourceLimits
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
	/**
	 * Monotonic milliseconds, paired with `now`. The worker uses it to bound
	 * a server-issued lease against a wall clock that may drift or be
	 * stepped; absent, it reads the process clock directly.
	 */
	monotonicNow?: () => number;
	/**
	 * Free-disk probe for the node's workspace volume. Optional: without
	 * it the node simply reports no disk figure, exactly as it did before
	 * the field existed. `node-io.ts` supplies the real `node:fs`-backed
	 * one; the renderer and every test can leave it out.
	 */
	diskProbe?: DiskProbeIo;
	/** Path whose volume the disk probe measures. Defaults to the node's cwd. */
	workspacePath?: string;
}

/**
 * Telemetry probes for the runner-status fields (agent-CLI version, free
 * disk), built from whatever the caller's {@link NodeIo} actually
 * supplies.
 *
 * Both probes are best-effort by construction — `describeSelf` treats a
 * throwing or null probe as an absent field, and the platform reads an
 * absent field as "leave the stored reading alone". So a machine with no
 * agent CLI, or an unreadable volume, keeps heartbeating with everything
 * else intact.
 */
export function buildSelfDescriptionTelemetry(io: NodeIo): SelfDescriptionTelemetry {
	const telemetry: SelfDescriptionTelemetry = {
		cliVersion: () => detectAgentCliVersion(io.runner)
	};
	if (io.diskProbe) {
		const probe = io.diskProbe;
		const path = io.workspacePath ?? process.cwd();
		telemetry.diskFreeBytes = () => detectDiskFreeBytes(probe, path);
	}
	return telemetry;
}

export interface EnrollNodeOptions extends NodeIo {
	apiUrl: string;
	token: string;
	kind: FleetEnrollableNodeKind;
	/** Local display label. Optional — defaults to the platform-assigned name. */
	name?: string;
	heartbeatIntervalMs?: number;
	/**
	 * Operator's capability opt-in (wizard step 3). Omitted means "advertise
	 * everything detected"; supplied, it can only shrink the offer.
	 */
	capabilitySelection?: readonly string[];
	/** Operator's resource ceilings (wizard step 4). Clamped before storage. */
	limits?: Partial<NodeResourceLimits>;
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

	const description = await describeSelf(
		options.runner,
		options.environment,
		options.version,
		options.capabilitySelection ?? null,
		buildSelfDescriptionTelemetry(options)
	);
	logger.info(`Enrolling with ${client.baseUrl} as ${description.platform} [${description.capabilities.join(', ')}]`);

	const result = await client.enroll({ token: options.token, ...description });
	logger.protect(result.secret);

	const limits = clampResourceLimits(options.limits);
	const config: NodeConfig = {
		apiUrl: client.baseUrl,
		nodeId: result.nodeId,
		secret: result.secret,
		kind: options.kind,
		capabilities: description.capabilities,
		limits,
		heartbeatIntervalMs: clampHeartbeatInterval(options.heartbeatIntervalMs),
		enrolledAt: new Date(options.now ? options.now() : Date.now()).toISOString()
	};
	if (options.capabilitySelection) {
		config.capabilitySelection = [...options.capabilitySelection];
	}
	const label = options.name?.trim() || result.node.name;
	if (label) {
		config.name = label;
	}

	logger.info(
		`Enrolled as node ${result.nodeId} ("${config.name ?? 'unnamed'}") — ` +
			`max ${limits.maxConcurrentJobs} concurrent job(s)`
	);
	return config;
}

export interface EnrollWithCredentialsOptions extends Omit<EnrollNodeOptions, 'token'> {
	email: string;
	/** Used for exactly one request; never stored, never logged. */
	password: string;
	/** Name registered with the platform when minting the token. */
	nodeName: string;
}

/**
 * The authenticate leg (A14): sign in, mint a one-time enrollment token, then
 * run the ordinary {@link enrollNode} path with it.
 *
 * The single-use token still exists and is still consumed exactly once — this
 * removes the clipboard from the loop, not the protocol step. The password
 * lives only in this call frame; only the resulting heartbeat secret is ever
 * persisted, by the caller's `saveConfig`.
 */
export async function enrollNodeWithCredentials(options: EnrollWithCredentialsOptions): Promise<NodeConfig> {
	const { logger } = options;
	const auth = new PlatformAuthClient({
		apiUrl: options.apiUrl,
		fetchFn: options.fetchFn,
		logger,
		userAgent: options.userAgent ?? `ever-works-node/${options.version}`
	});

	const session = await auth.signIn(options.email, options.password);
	logger.info(`Signed in to ${auth.baseUrl}${session.email ? ` as ${session.email}` : ''}`);

	const token = await auth.createEnrollmentToken(session.sessionToken, {
		name: options.nodeName,
		kind: options.kind
	});
	logger.info('Enrollment token minted for this machine');

	const { email: _email, password: _password, nodeName, ...rest } = options;
	return enrollNode({
		...rest,
		token,
		// The local label defaults to the name we just registered, so the
		// status window and the Fleet page agree without a second prompt.
		...(rest.name ? {} : { name: nodeName })
	});
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
	/**
	 * Max jobs in flight on this node. Superseded by the stored
	 * `config.limits.maxConcurrentJobs` when the node has limits.
	 */
	concurrency?: number;
	/**
	 * Override the stored resource ceilings. Normally omitted — the node's
	 * own `config.limits` is the source of truth.
	 */
	limits?: Partial<NodeResourceLimits>;
	/** Host sampler backing the CPU/memory admission gate. */
	resourceProbe?: ResourceProbe;
	leaseTtlSec?: number;
	idlePollMs?: number;
	/**
	 * Lease an `agent-task` must have left before it may start pushing.
	 * Absent uses the fleet default; raise it on a machine whose uplink
	 * makes a first push of an agent's diff take longer than that.
	 */
	publishFenceMarginMs?: number;
	/**
	 * Directory `agent-task` steps run in when the job itself carries no
	 * `workspacePath`. Absent lets the executor fall back to the node
	 * service's own working directory.
	 */
	agentTaskWorkspacePath?: string;
	/** Persistent bare-cache/worktree root for repository-backed agent Tasks. */
	agentTaskWorkspaceRoot?: string;
	/** Test/embedding seam; ordinary runtimes use the local-workspace provider. */
	workspaceProvisioner?: Pick<FleetTaskWorkspaceProvisioner, 'provision'> &
		Partial<Pick<FleetTaskWorkspaceProvisioner, 'finalize'>>;
	/**
	 * Agent execution v2 — the model CLIs the `agent-task` executor may
	 * spawn. Defaults to what `io.environment.modelCli` resolved at
	 * startup; an explicit value (the `--claude-path` / `--codex-path`
	 * flags) overrides it for this process only.
	 */
	modelCli?: ModelCliPaths;
	/** Scratch root for the model step's instructions / output files. */
	agentTaskScratchRoot?: string;
	/** Persist a fail-closed worker quarantine into the node config. */
	persistUnsafe?: (state: { since: string; reason: string }) => Promise<void> | void;
	/** Durable write-ahead crash guard; acquired before the first job lease. */
	workerSafetyGate?: WorkerSafetyGate;

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

	// Re-detection stays intersected with the operator's opt-in, so a tool
	// installed after enrollment never silently widens what this node offers.
	const selection = config.capabilitySelection ?? null;
	const telemetry = buildSelfDescriptionTelemetry(io);
	const loopOptions = {
		client,
		nodeId: config.nodeId,
		secret: config.secret,
		// Re-probed on EVERY beat, like the capability tags: installing an
		// agent CLI or filling a disk is exactly the kind of change an
		// operator needs to see without restarting the node.
		describe: () => describeSelf(io.runner, io.environment, io.version, selection, telemetry),
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
		// Precedence: explicit override → the node's stored limits → the
		// legacy `concurrency` option → defaults.
		const limits = clampResourceLimits(
			options.limits ??
				config.limits ??
				(options.concurrency !== undefined ? { maxConcurrentJobs: options.concurrency } : null)
		);
		const worker = new WorkerLoop({
			client: jobClient,
			logger: io.logger,
			limits,
			...(options.resourceProbe ? { resourceProbe: options.resourceProbe } : {}),
			...(options.leaseTtlSec !== undefined ? { leaseTtlSec: options.leaseTtlSec } : {}),
			...(options.idlePollMs !== undefined ? { idlePollMs: options.idlePollMs } : {}),
			...(options.publishFenceMarginMs !== undefined
				? { publishFenceMarginMs: options.publishFenceMarginMs }
				: {}),
			...(options.startPaused !== undefined ? { startPaused: options.startPaused } : {}),
			...(config.unsafe ? { startUnsafe: config.unsafe } : {}),
			...(options.persistUnsafe ? { onUnsafe: options.persistUnsafe } : {}),
			...(options.workerSafetyGate ? { safetyGate: options.workerSafetyGate } : {}),
			...(io.scheduler ? { scheduler: io.scheduler } : {}),
			...(io.now ? { now: io.now } : {}),
			...(io.monotonicNow ? { monotonicNow: io.monotonicNow } : {})
		});
		const workspaceProvisioner =
			options.workspaceProvisioner ??
			new FleetTaskWorkspaceProvisioner({
				rootPath: options.agentTaskWorkspaceRoot ?? defaultFleetTaskWorkspaceRoot()
			});
		// The executor seam: a job kind is one more `register` call
		// against the same protocol — no new endpoint, no new credential.
		worker.register('acceptance-checks', (job, signal) => runAcceptanceChecksJob(job, {}, signal));
		// The general kind. Without it an enrolled machine could only ever
		// score a gate; with it a Task's run can actually EXECUTE here when
		// the owner's resolved job runtime is the fleet. Same seam, same
		// protocol, same credential — exactly as the header above promised.
		// Agent execution v2 — the model CLIs resolved at startup (or pinned
		// by the operator for this process). Absent on a machine without
		// either CLI: a job that asks for model execution then fails naming
		// the missing CLI rather than pretending to have run it.
		const modelCli = options.modelCli ?? io.environment.modelCli ?? {};
		worker.register('agent-task', (job, signal, lease) =>
			runAgentTaskJob(
				job,
				{
					provisionWorkspace: (taskId, spec, provisionSignal) =>
						workspaceProvisioner.provision(taskId, spec, provisionSignal),
					...(workspaceProvisioner.finalize
						? {
								finalizeWorkspace: (taskId, descriptor, opts, finalizeSignal) =>
									workspaceProvisioner.finalize!(taskId, descriptor, opts, finalizeSignal)
							}
						: {}),
					// `agent-task` is the only kind that writes to a remote, so
					// it is the only kind that has to know when this node stops
					// being allowed to. Resolved through the handle, never
					// captured: the deadline moves with every renewal, and
					// `confirmDeadline` re-asks the platform at the moment of
					// the write — which is the only way to see a claim that was
					// taken away (an operator drained this node) while its
					// deadline was still minutes in the future.
					...(lease
						? {
								publishFence: async () => ({
									deadlineAt: await lease.confirmDeadline(),
									marginMs: lease.publishMarginMs
								}),
								// A withheld publish is not a verdict about the
								// work — nothing ran to a conclusion — so the
								// job goes back unsettled rather than terminal.
								onPublishWithheld: (reason: string) => lease.defer(reason)
							}
						: {}),
					modelCli,
					...(options.agentTaskScratchRoot !== undefined
						? { scratchRoot: options.agentTaskScratchRoot }
						: {}),
					...(options.agentTaskWorkspacePath !== undefined
						? { defaultWorkspacePath: options.agentTaskWorkspacePath }
						: {})
				},
				signal
			)
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
