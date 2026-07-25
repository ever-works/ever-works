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
	| 'job-runtime-inngest';

/** Local services supervised by the desktop shell. */
export type ServiceId = 'api' | 'web';

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
	selection?: RuntimeSelection;
	envFilePath?: string;
}

export const IpcChannels = {
	checkPrereqs: 'wizard:check-prereqs',
	listRuntimes: 'wizard:list-runtimes',
	detectDocker: 'wizard:detect-docker',
	applyRuntime: 'wizard:apply-runtime',
	completeWizard: 'wizard:complete',
	getConfig: 'config:get',
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
	completeWizard(): Promise<void>;
	getConfig(): Promise<DesktopConfig>;
	startServices(): Promise<void>;
	stopServices(): Promise<void>;
	restartService(id: ServiceId): Promise<void>;
	getStatus(): Promise<ServiceStatus[]>;
	getLogs(id: ServiceId): Promise<LogEntry[]>;
	openWebApp(): Promise<void>;
	onStatus(listener: (statuses: ServiceStatus[]) => void): () => void;
	onLog(listener: (entry: LogEntry) => void): () => void;
}
