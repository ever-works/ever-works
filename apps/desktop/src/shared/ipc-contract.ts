/**
 * Typed IPC contract shared by the Electron main process, the preload bridge
 * and the renderer wizard UI.
 *
 * NOTE: the preload script runs sandboxed and cannot `require` local modules,
 * so it re-declares the channel names as string literals. Keep
 * {@link IpcChannels} and `src/main/preload.ts` in sync.
 */

/** Plugin ids of the supported job runtimes (the `job-runtime-*` plugin family). */
export type RuntimeId =
	| 'job-runtime-bullmq'
	| 'job-runtime-pgboss'
	| 'job-runtime-temporal'
	| 'job-runtime-trigger'
	| 'job-runtime-inngest'
	// Desktop PRD M4 — the fleet runtime: work executes on the machines
	// the owner enrolled in Fleet rather than on an external broker.
	| 'job-runtime-node';

/** Local services supervised by the desktop shell. */
export type ServiceId = 'api' | 'web';

/**
 * How this install runs the platform.
 *
 * - `local-stack` — the desktop shell supervises its own API + web processes
 *   (the original all-in-one behavior).
 * - `remote-client` — no local stack at all: the shell is a native window onto
 *   an Ever Works instance that already runs somewhere else (self-hosted, a
 *   colleague's server, the hosted platform).
 */
export type DesktopMode = 'local-stack' | 'remote-client';

export const DEFAULT_DESKTOP_MODE: DesktopMode = 'local-stack';

/** User-entered remote instance details, before normalization/validation. */
export interface RemoteConnectionInput {
	/** Instance URL the window loads, e.g. `https://app.example.com`. */
	webUrl: string;
	/** API base URL. Derived from {@link webUrl} when omitted. */
	apiUrl?: string;
	/** Optional display label for the status screen. */
	label?: string;
}

/** A normalized, validated remote instance the shell can connect to. */
export interface RemoteConnection {
	webUrl: string;
	apiUrl: string;
	label?: string;
}

/** Result of probing a remote instance's health endpoint. */
export interface RemoteProbeResult {
	ok: boolean;
	status?: number;
	/** Reported platform version, when the health payload exposes one. */
	version?: string;
	message?: string;
}

/**
 * Where the supervised local services come from.
 *
 * - `bundled` — a self-contained runtime payload shipped inside the installer
 *   (`resources/app-bundle`). No monorepo checkout, Node.js or pnpm needed.
 * - `repo` — a developer monorepo checkout (dev runs, or `EVER_WORKS_REPO_ROOT`).
 * - `unavailable` — neither is present; local-stack mode cannot start.
 */
export type RuntimeLayoutKind = 'bundled' | 'repo' | 'unavailable';

export interface RuntimeLayoutSummary {
	kind: RuntimeLayoutKind;
	/** Absolute root of the bundled payload (`bundled` only). */
	bundleRoot?: string;
	/** Absolute monorepo checkout root (`repo` only). */
	repoRoot?: string;
	/** Version recorded in the bundle manifest (`bundled` only). */
	bundleVersion?: string;
	/** Why the layout resolved this way — always populated for `unavailable`. */
	reason?: string;
	/** True when the local stack needs Node.js + pnpm on PATH (repo layout). */
	requiresHostToolchain: boolean;
}

/** Lifecycle states of a supervised child process. */
export type ProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting' | 'crashed' | 'failed';

export interface PrereqCheckResult {
	id: 'node' | 'pnpm' | 'docker';
	label: string;
	/** Required prereqs block the wizard; optional ones only inform choices. */
	required: boolean;
	found: boolean;
	version?: string;
	ok: boolean;
	message?: string;
}

export interface RuntimeFieldDescriptor {
	/** Environment variable name written to the generated env file. */
	key: string;
	label: string;
	required: boolean;
	secret: boolean;
	defaultValue?: string;
	placeholder?: string;
}

export interface RuntimeDescriptor {
	id: RuntimeId;
	name: string;
	description: string;
	recommended: boolean;
	requiresRedis: boolean;
	requiresPostgres: boolean;
	fields: RuntimeFieldDescriptor[];
}

/** How the local API should persist data. */
export type DatabaseChoice = 'embedded-sqlite' | 'docker-postgres' | 'external-postgres';

export interface RuntimeSelection {
	runtimeId: RuntimeId;
	/** Env var name -> user-provided value (falls back to field defaults). */
	values: Record<string, string>;
	database: DatabaseChoice;
	/** Provision Postgres/Redis via `docker compose -f docker-compose.infra.yml up -d`. */
	useDockerInfra: boolean;
	/** Only used when database === 'external-postgres'. */
	externalDatabaseUrl?: string;
}

export interface ServiceStatus {
	id: ServiceId;
	state: ProcessState;
	pid?: number;
	restarts: number;
	lastExitCode?: number | null;
	healthy: boolean;
}

export interface LogEntry {
	serviceId: ServiceId;
	stream: 'stdout' | 'stderr' | 'system';
	line: string;
	at: number;
}

export interface DesktopConfig {
	wizardCompleted: boolean;
	/** Local stack vs. remote client. Defaults to {@link DEFAULT_DESKTOP_MODE}. */
	mode: DesktopMode;
	selection?: RuntimeSelection;
	envFilePath?: string;
	/** Only meaningful when `mode === 'remote-client'`. */
	remote?: RemoteConnection;
}

export const IpcChannels = {
	checkPrereqs: 'wizard:check-prereqs',
	listRuntimes: 'wizard:list-runtimes',
	detectDocker: 'wizard:detect-docker',
	applyRuntime: 'wizard:apply-runtime',
	setMode: 'wizard:set-mode',
	testRemote: 'wizard:test-remote',
	saveRemote: 'wizard:save-remote',
	completeWizard: 'wizard:complete',
	getConfig: 'config:get',
	getRuntimeLayout: 'app:runtime-layout',
	startServices: 'services:start',
	stopServices: 'services:stop',
	restartService: 'services:restart',
	getStatus: 'services:status',
	getLogs: 'services:logs',
	openWebApp: 'app:open-web',
	statusEvent: 'services:status-event',
	logEvent: 'services:log-event'
} as const;

/** The minimal typed bridge exposed to the renderer as `window.everworks`. */
export interface DesktopBridge {
	checkPrereqs(): Promise<PrereqCheckResult[]>;
	listRuntimes(): Promise<RuntimeDescriptor[]>;
	detectDocker(): Promise<{ available: boolean; version?: string }>;
	applyRuntime(selection: RuntimeSelection): Promise<{ envFilePath: string; keys: string[] }>;
	/** Switch between the local stack and remote-client modes. */
	setMode(mode: DesktopMode): Promise<DesktopConfig>;
	/** Validate + probe a remote instance without persisting it. */
	testRemote(input: RemoteConnectionInput): Promise<RemoteProbeResult>;
	/** Persist the remote instance the shell should connect to. */
	saveRemote(input: RemoteConnectionInput): Promise<RemoteConnection>;
	completeWizard(): Promise<void>;
	getConfig(): Promise<DesktopConfig>;
	/** Where the local services come from (bundled payload, repo checkout, or nothing). */
	getRuntimeLayout(): Promise<RuntimeLayoutSummary>;
	startServices(): Promise<void>;
	stopServices(): Promise<void>;
	restartService(id: ServiceId): Promise<void>;
	getStatus(): Promise<ServiceStatus[]>;
	getLogs(id: ServiceId): Promise<LogEntry[]>;
	openWebApp(): Promise<void>;
	onStatus(listener: (statuses: ServiceStatus[]) => void): () => void;
	onLog(listener: (entry: LogEntry) => void): () => void;
}
