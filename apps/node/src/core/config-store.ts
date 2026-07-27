import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	isFleetEnrollableNodeKind,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	type FleetEnrollableNodeKind,
	type NodeConfig
} from './types';

/**
 * Node config persistence.
 *
 * The config file holds the heartbeat secret, so it is written to the OS
 * config directory with 0600 permissions on POSIX platforms. Windows has no
 * POSIX mode bits (`fs.chmod` there only toggles the read-only flag), so the
 * chmod is skipped rather than faked — the file inherits the user profile's
 * ACL, which is already user-scoped.
 *
 * All filesystem access is injected so persistence is testable without a real
 * disk, and so the Electron shell can point it at `app.getPath('userData')`.
 */

export const CONFIG_DIR_NAME = 'ever-works-node';
export const CONFIG_FILE_NAME = 'node-config.json';
/** Owner read/write only. */
export const CONFIG_FILE_MODE = 0o600;

/** Environment variable that overrides the config file location entirely. */
export const CONFIG_PATH_ENV = 'EVER_WORKS_NODE_CONFIG';

export interface ConfigFileSystem {
	/** Return the file's contents, or null when it does not exist. */
	readFile(filePath: string): Promise<string | null>;
	writeFile(filePath: string, content: string): Promise<void>;
	mkdir(dirPath: string): Promise<void>;
	chmod(filePath: string, mode: number): Promise<void>;
	dirname(filePath: string): string;
}

export interface ResolveConfigPathInput {
	env: Record<string, string | undefined>;
	platform: string;
	homedir: string;
	join(...segments: string[]): string;
}

/**
 * Where the node config lives, per platform convention:
 *
 * - `$EVER_WORKS_NODE_CONFIG` — explicit override, used verbatim
 * - Windows: `%APPDATA%\ever-works-node\node-config.json`
 * - macOS:   `~/Library/Application Support/ever-works-node/node-config.json`
 * - Linux:   `$XDG_CONFIG_HOME/ever-works-node/node-config.json`
 *            (falling back to `~/.config`)
 */
export function resolveConfigPath(input: ResolveConfigPathInput): string {
	const override = input.env[CONFIG_PATH_ENV];
	if (override && override.trim()) {
		return override.trim();
	}

	const { join, homedir, platform, env } = input;
	if (platform === 'win32') {
		const appData = env.APPDATA?.trim() || join(homedir, 'AppData', 'Roaming');
		return join(appData, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	}
	if (platform === 'darwin') {
		return join(homedir, 'Library', 'Application Support', CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	}
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const base = xdg || join(homedir, '.config');
	return join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function clampInterval(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_HEARTBEAT_INTERVAL_MS;
	}
	return Math.min(Math.max(Math.round(value), MIN_HEARTBEAT_INTERVAL_MS), MAX_HEARTBEAT_INTERVAL_MS);
}

/**
 * Parse stored config. Anything unusable — missing file, invalid JSON, missing
 * credential — reads as "not enrolled" (null) rather than throwing, mirroring
 * the desktop shell's `loadConfig` posture: a corrupt file must not wedge the
 * node, it must send the operator back through enrollment.
 */
export function parseConfig(raw: string | null): NodeConfig | null {
	if (!raw) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}
	const candidate = parsed as Partial<NodeConfig>;
	if (
		typeof candidate.apiUrl !== 'string' ||
		!candidate.apiUrl ||
		typeof candidate.nodeId !== 'string' ||
		!candidate.nodeId ||
		typeof candidate.secret !== 'string' ||
		!candidate.secret
	) {
		return null;
	}

	// Unrecognised kinds are DROPPED to the safe default, never trusted:
	// the enrollable set is the shared contract's, so a server-side
	// addition needs no edit here.
	const kind: FleetEnrollableNodeKind = isFleetEnrollableNodeKind(candidate.kind) ? candidate.kind : 'node';

	const config: NodeConfig = {
		apiUrl: candidate.apiUrl,
		nodeId: candidate.nodeId,
		secret: candidate.secret,
		kind,
		capabilities: Array.isArray(candidate.capabilities)
			? candidate.capabilities.filter((tag): tag is string => typeof tag === 'string')
			: [],
		heartbeatIntervalMs: clampInterval(candidate.heartbeatIntervalMs),
		enrolledAt: typeof candidate.enrolledAt === 'string' ? candidate.enrolledAt : new Date(0).toISOString()
	};
	if (typeof candidate.name === 'string' && candidate.name) {
		config.name = candidate.name;
	}
	return config;
}

export async function loadConfig(fs: ConfigFileSystem, filePath: string): Promise<NodeConfig | null> {
	let raw: string | null;
	try {
		raw = await fs.readFile(filePath);
	} catch {
		return null;
	}
	return parseConfig(raw);
}

export interface SaveConfigOptions {
	/** `process.platform`; the 0600 chmod is skipped on `win32`. */
	platform?: string;
}

/**
 * Persist the config, creating the directory tree as needed, then tighten the
 * file mode to 0600. A chmod failure is not fatal (some filesystems — CIFS,
 * FAT, container overlays — do not support it) but the write itself is.
 */
export async function saveConfig(
	fs: ConfigFileSystem,
	filePath: string,
	config: NodeConfig,
	options: SaveConfigOptions = {}
): Promise<void> {
	await fs.mkdir(fs.dirname(filePath));
	await fs.writeFile(filePath, `${JSON.stringify(config, null, '\t')}\n`);
	if (options.platform === 'win32') {
		return;
	}
	try {
		await fs.chmod(filePath, CONFIG_FILE_MODE);
	} catch {
		// Best-effort: the file is written, the mode just could not be tightened.
	}
}
