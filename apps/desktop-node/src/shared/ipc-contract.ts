import type {
	ConnectionState,
	FleetNodeKind,
	FleetNodeStatus,
	LogEntry,
	NodeResourceLimits,
	WorkerLoopState
} from 'ever-works-node';

/**
 * Typed IPC contract shared by the Electron main process, the preload bridge
 * and the renderer (setup wizard + status window).
 *
 * SECURITY: the heartbeat secret never appears in any type below. It is minted
 * during enrollment, written to the protected config file by the main process,
 * and never crosses this boundary — the renderer only ever learns *that* a
 * credential exists ({@link NodeIdentityView.enrolled}).
 *
 * NOTE: the preload script runs sandboxed and cannot `require` local modules,
 * so it re-declares the channel names as string literals. Keep
 * {@link IpcChannels} and `src/main/preload.ts` in sync. (The type-only import
 * above is erased at compile time and is therefore sandbox-safe.)
 */

export type { ConnectionState, LogEntry, NodeResourceLimits, WorkerLoopState };

/** Where this node's control plane lives (PRD §3.2 wizard step 1). */
export type ApiHostChoice = 'local-desktop' | 'self-hosted' | 'cloud';

export interface ApiHostOption {
	id: ApiHostChoice;
	label: string;
	description: string;
	/** Fixed URL for preset choices; undefined when the operator supplies one. */
	url?: string;
}

/** Default API port of a local all-in-one desktop install (`apps/desktop`). */
export const LOCAL_DESKTOP_API_URL = 'http://localhost:3100';
export const CLOUD_API_URL = 'https://api.ever.works';

/**
 * Credential bounds, mirroring `CREDENTIAL_MIN_LENGTH`/`CREDENTIAL_MAX_LENGTH`
 * in the platform's `fleet.service.ts` (and `MIN/MAX_CREDENTIAL_LENGTH` in the
 * node core).
 *
 * Deliberately plain literals rather than a re-export of the core constants:
 * this module is bundled into the RENDERER, and importing `ever-works-node` as
 * a value would drag the Node-only IO adapters (`node:child_process`,
 * `node:fs`) into a browser bundle. The type-only import above is erased and
 * therefore safe.
 */
export const MIN_TOKEN_LENGTH = 16;
export const MAX_TOKEN_LENGTH = 256;

export const API_HOST_OPTIONS: ApiHostOption[] = [
	{
		id: 'local-desktop',
		label: 'Local desktop install',
		description: 'An Ever Works Desktop all-in-one running on this machine.',
		url: LOCAL_DESKTOP_API_URL
	},
	{
		id: 'self-hosted',
		label: 'Self-hosted',
		description: 'Your own platform API — enter its base URL.'
	},
	{
		id: 'cloud',
		label: 'Cloud',
		description: 'The hosted Ever Works platform.',
		url: CLOUD_API_URL
	}
];

/**
 * Resource ceilings the wizard collects (PRD §3.2 step 4) and this machine
 * enforces on itself. Mirrors the core's `NodeResourceLimits` as a plain
 * renderer-safe shape.
 */
export const DEFAULT_LIMITS_VIEW: NodeResourceLimits = {
	maxConcurrentJobs: 1,
	maxCpuPercent: null,
	maxMemoryMb: null
};

/** Concurrency bounds mirrored from the core (`MIN/MAX_CONCURRENT_JOBS`). */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;
/** CPU ceiling bounds mirrored from the core (`MIN/MAX_CPU_PERCENT`). */
export const MIN_CPU_CEILING = 5;
export const MAX_CPU_CEILING = 100;
/** Memory ceiling floor mirrored from the core (`MIN_MEMORY_MB`). */
export const MIN_MEMORY_CEILING_MB = 256;

/** Credential-free view of the local enrollment, safe to send to the renderer. */
export interface NodeIdentityView {
	enrolled: boolean;
	nodeId?: string;
	apiUrl?: string;
	name?: string;
	kind?: FleetNodeKind;
	capabilities: string[];
	/** Operator's capability opt-in; absent = "everything detected". */
	capabilitySelection?: string[];
	/** Ceilings this node enforces on itself. */
	limits: NodeResourceLimits;
	heartbeatIntervalMs?: number;
	enrolledAt?: string;
}

/** Work-execution view rendered next to the connection status (A18). */
export interface WorkerStatusView {
	/** False when this node was enrolled for visibility only. */
	enabled: boolean;
	/** True while the operator has paused leasing. */
	paused: boolean;
	state: WorkerLoopState['state'] | 'disabled';
	activeJobCount: number;
	completed: number;
	failed: number;
	/** Why the loop last declined to lease on resource grounds, or null. */
	throttleReason: string | null;
}

export const IDLE_WORKER_STATUS: WorkerStatusView = {
	enabled: false,
	paused: false,
	state: 'disabled',
	activeJobCount: 0,
	completed: 0,
	failed: 0,
	throttleReason: null
};

/** Live connection status rendered by the status window and the tray. */
export interface ConnectionStatusView {
	state: ConnectionState;
	/** Epoch ms of the last accepted heartbeat. */
	lastHeartbeatAt: number | null;
	consecutiveFailures: number;
	nextAttemptInMs: number | null;
	/** Last failure message — already redacted by the core logger. */
	lastError: string | null;
	/** Node status as the platform sees it, from the last heartbeat response. */
	platformStatus: FleetNodeStatus | null;
	/** Work execution state — pause/resume is driven off this (A18). */
	worker: WorkerStatusView;
}

/**
 * How the wizard obtained the right to enroll:
 *   - `token`    the operator pasted a one-time token from Fleet settings
 *   - `sign-in`  the operator signed in and the app minted the token itself
 */
export type EnrollMode = 'token' | 'sign-in';

/**
 * Wizard → main enrollment request. Credentials are write-only across this
 * bridge: neither the token nor the password can ever be read back out.
 */
export interface EnrollRequest {
	host: ApiHostChoice;
	/** Required when `host === 'self-hosted'`; ignored otherwise. */
	apiUrl?: string;
	mode?: EnrollMode;
	/** Required when `mode` is `token` (the default). */
	token?: string;
	/** Required when `mode === 'sign-in'`. */
	email?: string;
	/**
	 * Required when `mode === 'sign-in'`. Used for exactly one request in the
	 * main process and never stored, logged, or echoed back.
	 */
	password?: string;
	name?: string;
	/**
	 * Capability tags this machine offers (A15). Omitted = advertise
	 * everything detected.
	 */
	capabilities?: string[];
	/** Resource ceilings this machine enforces on itself (A16). */
	limits?: NodeResourceLimits;
}

export interface EnrollOutcome {
	ok: boolean;
	identity?: NodeIdentityView;
	/** Operator-facing failure reason; never contains the token or password. */
	error?: string;
}

/** Wizard → main sign-in request (A14). The password is write-only. */
export interface AuthenticateRequest {
	host: ApiHostChoice;
	/** Required when `host === 'self-hosted'`; ignored otherwise. */
	apiUrl?: string;
	email: string;
	password: string;
}

export interface AuthenticateOutcome {
	ok: boolean;
	/** Echoed back so the wizard can confirm WHICH account signed in. */
	email?: string;
	/** Operator-facing failure reason; never contains the password. */
	error?: string;
}

export const IpcChannels = {
	listApiHosts: 'wizard:list-api-hosts',
	detectCapabilities: 'wizard:detect-capabilities',
	authenticate: 'wizard:authenticate',
	enroll: 'wizard:enroll',
	getConfig: 'config:get',
	connect: 'node:connect',
	disconnect: 'node:disconnect',
	pause: 'node:pause',
	resume: 'node:resume',
	getStatus: 'node:status',
	getLogs: 'node:logs',
	unenroll: 'node:unenroll',
	statusEvent: 'node:status-event',
	logEvent: 'node:log-event'
} as const;

/** The minimal typed bridge exposed to the renderer as `window.everworksNode`. */
export interface DesktopNodeBridge {
	listApiHosts(): Promise<ApiHostOption[]>;
	detectCapabilities(): Promise<string[]>;
	/**
	 * Verify the operator's platform credentials without enrolling yet, so
	 * the wizard can fail fast on a typo before it collects capabilities and
	 * limits. The password never comes back across this bridge.
	 */
	authenticate(request: AuthenticateRequest): Promise<AuthenticateOutcome>;
	enroll(request: EnrollRequest): Promise<EnrollOutcome>;
	getConfig(): Promise<NodeIdentityView>;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/** Stop leasing new work; in-flight jobs still finish and report (A18). */
	pause(): Promise<void>;
	/** Resume leasing after a pause (A18). */
	resume(): Promise<void>;
	getStatus(): Promise<ConnectionStatusView>;
	getLogs(): Promise<LogEntry[]>;
	unenroll(): Promise<void>;
	onStatus(listener: (status: ConnectionStatusView) => void): () => void;
	onLog(listener: (entry: LogEntry) => void): () => void;
}
