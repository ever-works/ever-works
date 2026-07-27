import type { Logger } from './logger';
import type { SecretStore } from './secret-store';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	isFleetEnrollableNodeKind,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	type FleetEnrollableNodeKind,
	type NodeConfig,
	type FleetNodeKind,
	type NodeSecretStorage
} from './types';

/**
 * Node config persistence.
 *
 * The heartbeat secret is a credential, so it is kept OUT of the config
 * file whenever the host offers somewhere better: when a
 * {@link SecretStore} is supplied (the OS keychain — see
 * `secret-store.ts`) the file records only `secretStorage: 'keychain'`
 * and the credential itself lives in Keychain / Credential Manager /
 * Secret Service.
 *
 * When no keychain exists the secret falls back INTO the file, and the
 * file is then locked to its owner on every platform (audit A45):
 *
 *   - POSIX: created 0600 and re-chmod'd 0600 after the write;
 *   - Windows: `restrict()` applies an inheritance-stripped, owner-only
 *     ACL. The previous behaviour — skipping the tightening entirely on
 *     win32 because `fs.chmod` there only toggles the read-only bit —
 *     left the credential readable by anything the profile's inherited
 *     ACL admitted.
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
	/** Remove the file. Missing is success. */
	remove?(filePath: string): Promise<void>;
	/**
	 * Platform-native "owner only" tightening for hosts where POSIX mode
	 * bits are meaningless (Windows ACLs). Optional so existing
	 * implementations keep compiling; when absent on win32 the caller
	 * WARNS rather than silently doing nothing.
	 */
	restrict?(filePath: string): Promise<void>;
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
	const secretStorage: NodeSecretStorage = candidate.secretStorage === 'keychain' ? 'keychain' : 'file';
	const inlineSecret = typeof candidate.secret === 'string' ? candidate.secret : '';
	if (
		typeof candidate.apiUrl !== 'string' ||
		!candidate.apiUrl ||
		typeof candidate.nodeId !== 'string' ||
		!candidate.nodeId ||
		// A keychain-backed config legitimately carries no secret here —
		// `loadConfig` fetches it from the OS store. Anything else with an
		// empty credential is unusable and reads as "not enrolled".
		(secretStorage === 'file' && !inlineSecret)
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
		secret: inlineSecret,
		kind,
		capabilities: Array.isArray(candidate.capabilities)
			? candidate.capabilities.filter((tag): tag is string => typeof tag === 'string')
			: [],
		heartbeatIntervalMs: clampInterval(candidate.heartbeatIntervalMs),
		enrolledAt: typeof candidate.enrolledAt === 'string' ? candidate.enrolledAt : new Date(0).toISOString(),
		secretStorage,
		paused: candidate.paused === true
	};
	if (typeof candidate.name === 'string' && candidate.name) {
		config.name = candidate.name;
	}
	return config;
}

export interface LoadConfigOptions {
	/** OS keychain, when one is available on this host. */
	secrets?: SecretStore | null;
	logger?: Logger;
}

/**
 * Read the stored config and rehydrate its credential.
 *
 * A `keychain`-backed config whose secret has vanished from the OS
 * store (keychain reset, profile migrated, entry revoked by hand) reads
 * as NOT ENROLLED rather than as a config with an empty secret: a node
 * that keeps beating with a blank credential would just hammer the API
 * for 401s until someone noticed.
 */
export async function loadConfig(
	fs: ConfigFileSystem,
	filePath: string,
	options: LoadConfigOptions = {}
): Promise<NodeConfig | null> {
	let raw: string | null;
	try {
		raw = await fs.readFile(filePath);
	} catch {
		return null;
	}
	const config = parseConfig(raw);
	if (!config) {
		return null;
	}
	if (config.secretStorage !== 'keychain') {
		options.logger?.warn(
			`Node credential is stored in ${filePath}. Install \`@napi-rs/keyring\` to move it into the OS keychain.`
		);
		return config;
	}

	if (!options.secrets) {
		options.logger?.error(
			'This node stored its credential in the OS keychain, but no keychain is available now. ' +
				'Re-run `ever-works-node enroll` to re-issue a credential.'
		);
		return null;
	}
	const secret = await options.secrets.get(config.nodeId);
	if (!secret) {
		options.logger?.error(
			`No credential for node ${config.nodeId} in the ${options.secrets.label}. ` +
				'Re-run `ever-works-node enroll` to re-issue one.'
		);
		return null;
	}
	options.logger?.protect(secret);
	return { ...config, secret };
}

export interface SaveConfigOptions {
	/** `process.platform`; decides chmod (POSIX) vs ACL (win32). */
	platform?: string;
	/** OS keychain. When present the secret NEVER reaches the file. */
	secrets?: SecretStore | null;
	logger?: Logger;
}

/**
 * Persist the config, creating the directory tree as needed, then lock the
 * file down to its owner.
 *
 * With a {@link SecretStore} the credential is written to the OS keychain
 * and the file records only where it lives. Without one the credential is
 * inlined and the file tightening becomes the ONLY thing protecting it, so
 * a failure to tighten is reported loudly instead of swallowed.
 */
export async function saveConfig(
	fs: ConfigFileSystem,
	filePath: string,
	config: NodeConfig,
	options: SaveConfigOptions = {}
): Promise<void> {
	let stored: NodeConfig = { ...config, secretStorage: 'file' };

	if (options.secrets && config.secret) {
		try {
			await options.secrets.set(config.nodeId, config.secret);
			// Only now is it safe to drop the secret from the file: if the
			// keychain write had failed we would have persisted a config
			// pointing at a credential that does not exist anywhere.
			stored = { ...config, secret: '', secretStorage: 'keychain' };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			options.logger?.warn(
				`Could not store the node credential in the ${options.secrets.label} (${options.logger.redact(
					detail
				)}); falling back to the config file.`
			);
		}
	}

	await fs.mkdir(fs.dirname(filePath));
	await fs.writeFile(filePath, `${JSON.stringify(stored, null, '\t')}\n`);
	await restrictConfigFile(fs, filePath, {
		platform: options.platform,
		secretOnDisk: stored.secretStorage !== 'keychain',
		...(options.logger ? { logger: options.logger } : {})
	});
}

/**
 * Tighten the config file to owner-only on any platform.
 *
 * Windows gets a real ACL through `fs.restrict` rather than the old
 * silent skip; POSIX gets the 0600 chmod. When the credential is on
 * disk and the tightening fails, the operator is TOLD — that is the
 * only remaining thing standing between the secret and every other
 * process on the machine.
 */
export async function restrictConfigFile(
	fs: ConfigFileSystem,
	filePath: string,
	options: { platform?: string; secretOnDisk: boolean; logger?: Logger }
): Promise<void> {
	const loud = (message: string): void => {
		if (options.secretOnDisk) {
			options.logger?.warn(message);
		}
	};

	if (options.platform === 'win32') {
		if (!fs.restrict) {
			loud(
				`Could not apply an owner-only ACL to ${filePath} on this host — the node credential is readable by anything the inherited ACL admits.`
			);
			return;
		}
		try {
			await fs.restrict(filePath);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			loud(`Could not apply an owner-only ACL to ${filePath}: ${detail}`);
		}
		return;
	}

	try {
		await fs.chmod(filePath, CONFIG_FILE_MODE);
	} catch (error) {
		// Some filesystems (CIFS, FAT, container overlays) genuinely
		// cannot do this. The write still stands — but say so.
		const detail = error instanceof Error ? error.message : String(error);
		loud(`Could not set 0600 on ${filePath}: ${detail}`);
	}
}

/**
 * Erase every local trace of an enrollment: the keychain entry first
 * (the credential itself), then the config file.
 *
 * Deleting the credential before the file is deliberate — a crash
 * between the two leaves a config whose secret is gone, which reads as
 * "not enrolled" and sends the operator back through `enroll`. The
 * other order would leave a live credential behind with nothing
 * pointing at it.
 */
export async function clearConfig(
	fs: ConfigFileSystem,
	filePath: string,
	config: NodeConfig | null,
	options: { secrets?: SecretStore | null } = {}
): Promise<void> {
	if (options.secrets && config?.nodeId) {
		try {
			await options.secrets.delete(config.nodeId);
		} catch {
			// Best-effort: a stuck keychain must not block the file removal.
		}
	}
	if (fs.remove) {
		try {
			await fs.remove(filePath);
			return;
		} catch {
			// Fall through to the overwrite below.
		}
	}
	// No removal available: overwrite with an empty object so the
	// credential is gone even if the file itself survives.
	await fs.writeFile(filePath, '{}\n');
}
