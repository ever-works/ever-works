import type { ConnectionState, FleetNodeKind, FleetNodeStatus, LogEntry } from 'ever-works-node';

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

export type { ConnectionState, LogEntry };

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

/** Credential-free view of the local enrollment, safe to send to the renderer. */
export interface NodeIdentityView {
	enrolled: boolean;
	nodeId?: string;
	apiUrl?: string;
	name?: string;
	kind?: FleetNodeKind;
	capabilities: string[];
	heartbeatIntervalMs?: number;
	enrolledAt?: string;
}

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
}

/** Wizard → main enrollment request. The token is write-only across this bridge. */
export interface EnrollRequest {
	host: ApiHostChoice;
	/** Required when `host === 'self-hosted'`; ignored otherwise. */
	apiUrl?: string;
	token: string;
	name?: string;
}

export interface EnrollOutcome {
	ok: boolean;
	identity?: NodeIdentityView;
	/** Operator-facing failure reason; never contains the token. */
	error?: string;
}

export const IpcChannels = {
	listApiHosts: 'wizard:list-api-hosts',
	detectCapabilities: 'wizard:detect-capabilities',
	enroll: 'wizard:enroll',
	getConfig: 'config:get',
	connect: 'node:connect',
	disconnect: 'node:disconnect',
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
	enroll(request: EnrollRequest): Promise<EnrollOutcome>;
	getConfig(): Promise<NodeIdentityView>;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	getStatus(): Promise<ConnectionStatusView>;
	getLogs(): Promise<LogEntry[]>;
	unenroll(): Promise<void>;
	onStatus(listener: (status: ConnectionStatusView) => void): () => void;
	onLog(listener: (entry: LogEntry) => void): () => void;
}
