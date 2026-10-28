import {
	replaceFileAtomically,
	sweepStaleTempFiles,
	type AtomicFileOps,
	type ReplaceFileOptions
} from './atomic-state-file';
import type { Logger } from './logger';
import type { SecretStore } from './secret-store';
import {
	clampResourceLimits,
	clampWorkspaceGcPolicy,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	isFleetEnrollableNodeKind,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	resolveNodeExecutionPolicy,
	type FleetEnrollableNodeKind,
	type NodeConfig,
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
 * Every write is ATOMIC (2026-10-28 incident: a node force-stopped while it
 * rewrote the file in place left a 0-byte config that read as "not
 * enrolled"). The new content goes into a same-directory temp file that is
 * made owner-only while it is still EMPTY, is flushed, and is then renamed
 * over the config; see `atomic-state-file.ts`. Each save also refreshes a
 * last-good copy (`node-config.json.bak`) through the same owner-only path,
 * and a config found empty or torn at load is recovered from it.
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
	/** Atomically create a new owner-only file; reject rather than overwrite. */
	createFileExclusive?(filePath: string, content: string): Promise<void>;
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
	/*
	 * The atomic-write primitives (see `atomic-state-file.ts`). Optional so
	 * existing test doubles keep compiling; a filesystem missing any of
	 * `createFileExclusive`, `writeExistingFile`, `rename` and `remove` is
	 * written IN PLACE, as before. The real one (`createConfigFileSystem`)
	 * has all of them, and a spec pins that.
	 */
	/** Write into an EXISTING file (never creating one), flushed to stable storage before resolving. */
	writeExistingFile?(filePath: string, content: string | Uint8Array): Promise<void>;
	/** Rename `from` over `to`, replacing it. */
	rename?(from: string, to: string): Promise<void>;
	/** Create `newPath` as another name for `existing`; reject (`EEXIST`) rather than replace. */
	link?(existing: string, newPath: string): Promise<void>;
	/** Flush a directory's entries to disk (POSIX). Best-effort. */
	syncDirectory?(dirPath: string): Promise<void>;
	/** The entry names of a directory; [] when it does not exist. */
	readDirectory?(dirPath: string): Promise<string[]>;
	/** The file's modification time, or null when it does not exist. */
	modifiedAtMs?(filePath: string): Promise<number | null>;
}

/** The node's state-file writers need only these members of a {@link ConfigFileSystem}. */
export type StateFileSystem = Pick<ConfigFileSystem, 'writeFile'> &
	Partial<
		Pick<
			ConfigFileSystem,
			'dirname' | 'createFileExclusive' | 'writeExistingFile' | 'rename' | 'remove' | 'syncDirectory'
		>
	>;

/** True when `fs` can replace a file atomically. */
export function supportsAtomicWrites(fs: StateFileSystem): fs is StateFileSystem & AtomicFileOps {
	return (
		typeof fs.createFileExclusive === 'function' &&
		typeof fs.writeExistingFile === 'function' &&
		typeof fs.rename === 'function' &&
		typeof fs.remove === 'function'
	);
}

/**
 * True when the operating system REFUSED the atomic path rather than the
 * write failing outright: the temp file could not be created beside the
 * target (a directory the account may not add files to), or the rename kept
 * failing after its retries (on Windows, another process holding the target
 * open: `MoveFileExW` cannot replace an open file). Writing in place, as the
 * node always did, can still succeed then. A full disk or an I/O error is
 * not this, and is reported as it is.
 */
function isAtomicPathRefused(error: unknown): boolean {
	if (error instanceof TempNotOwnerOnlyError) return true;
	const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
	return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * The staged temp file could not be proven owner-only, so it must not become
 * the config: a fresh file carries the directory's inherited ACL, and renaming
 * it over an existing owner-only config would WIDEN who can read it. Thrown
 * from `tighten`, before any content reaches the temp file; the save then
 * rewrites the existing file in place, which keeps its current ACL (the
 * previous behaviour).
 */
class TempNotOwnerOnlyError extends Error {
	constructor(tempPath: string) {
		super(`the staged file ${tempPath} could not be made owner-only`);
		this.name = 'TempNotOwnerOnlyError';
	}
}

/**
 * Replace `filePath` atomically; if the OS refuses the atomic path (see
 * {@link isAtomicPathRefused}), rewrite it in place the way the node always
 * did, and say so through `onFallback`. That is the previous behaviour as the
 * worst case, not a new failure: a `pause` must not start failing because a
 * backup agent holds the config open. Resolves `'atomic'` or `'in-place'`.
 */
async function replaceOrRewrite(
	fs: StateFileSystem & AtomicFileOps,
	filePath: string,
	content: string,
	options: Pick<ReplaceFileOptions, 'platform' | 'tighten'>,
	onFallback?: (error: unknown) => void
): Promise<'atomic' | 'in-place'> {
	try {
		await replaceFileAtomically(fs, filePath, content, options);
		return 'atomic';
	} catch (error) {
		if (!isAtomicPathRefused(error)) throw error;
		onFallback?.(error);
		await fs.writeFile(filePath, content);
		return 'in-place';
	}
}

/**
 * Write one of the node's state files (the lifecycle, link and self-update
 * records beside the config): atomically when the filesystem can, so a
 * kill mid-write leaves the previous record whole instead of a torn one.
 * These records hold no credential, so the temp file keeps its owner-only
 * creation mode (0600 on POSIX) and gets no extra ACL step.
 */
export async function writeStateFile(
	fs: StateFileSystem,
	filePath: string,
	content: string,
	options: Pick<ReplaceFileOptions, 'platform' | 'tighten'> = {}
): Promise<void> {
	if (!supportsAtomicWrites(fs)) {
		await fs.writeFile(filePath, content);
		return;
	}
	await replaceOrRewrite(fs, filePath, content, options);
}

/** The last-good copy of the config, refreshed on every successful save. */
export function configBackupPath(configPath: string): string {
	return `${configPath}.bak`;
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
/**
 * Rooted POSIX or Windows path. Written out rather than taken from
 * `node:path` on purpose: this module is deliberately free of node
 * builtins (it runs behind an injected filesystem seam), and
 * `path.isAbsolute` would answer differently depending on which OS the
 * process happens to be running on, for a config file that can be copied
 * between them.
 */
const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:[/\\])/;

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
		// A config written before limits existed reads as the conservative
		// default, so upgrading the app never widens what a node will do.
		limits: clampResourceLimits(candidate.limits),
		heartbeatIntervalMs: clampInterval(candidate.heartbeatIntervalMs),
		enrolledAt: typeof candidate.enrolledAt === 'string' ? candidate.enrolledAt : new Date(0).toISOString(),
		secretStorage,
		paused: candidate.paused === true
	};
	// Distinguish "no selection recorded" (advertise everything detected)
	// from "an empty selection" (offer only the identity tags) — dropping
	// the key entirely is the only way to mean the former.
	if (Array.isArray(candidate.capabilitySelection)) {
		config.capabilitySelection = candidate.capabilitySelection.filter(
			(tag): tag is string => typeof tag === 'string'
		);
	}
	if (typeof candidate.name === 'string' && candidate.name) {
		config.name = candidate.name;
	}
	// Present only once an operator set it: a config that never carried the
	// key keeps round-tripping without it (the default policy applies), and
	// an out-of-range stored value is clamped rather than refused.
	if (candidate.workspaceGc && typeof candidate.workspaceGc === 'object') {
		config.workspaceGc = clampWorkspaceGcPolicy(candidate.workspaceGc);
	}
	// The workspace root the service runs against, so `doctor` and `gc`
	// inspect the same tree (EW-803). Only ever an absolute path: a
	// relative one would be resolved against whatever directory the
	// operator happened to run the CLI from, which is the confusion this
	// key exists to end.
	if (typeof candidate.workspaceRoot === 'string' && ABSOLUTE_PATH.test(candidate.workspaceRoot.trim())) {
		config.workspaceRoot = candidate.workspaceRoot.trim();
	}
	// Checkouts on computers (FL-14): the code folders discovery walks. Only
	// absolute paths survive a read; anything else is dropped, never guessed.
	if (Array.isArray(candidate.codeFolders)) {
		const folders = candidate.codeFolders
			.filter((folder): folder is string => typeof folder === 'string' && ABSOLUTE_PATH.test(folder.trim()))
			.map((folder) => folder.trim())
			.slice(0, 32);
		if (folders.length > 0) config.codeFolders = [...new Set(folders)];
	}
	// Control 18: the machine owner's local execution policy. Present only once
	// `ever-works-node policy` wrote it; anything but a literal `true` reads as
	// OFF, so a hand-edited or truncated value can only ever narrow.
	if (candidate.executionPolicy && typeof candidate.executionPolicy === 'object') {
		config.executionPolicy = resolveNodeExecutionPolicy(candidate.executionPolicy);
	}
	if (
		candidate.unsafe &&
		typeof candidate.unsafe === 'object' &&
		typeof candidate.unsafe.since === 'string' &&
		Number.isFinite(Date.parse(candidate.unsafe.since)) &&
		typeof candidate.unsafe.reason === 'string' &&
		candidate.unsafe.reason.trim()
	) {
		config.unsafe = {
			since: new Date(candidate.unsafe.since).toISOString(),
			reason: candidate.unsafe.reason.trim().slice(0, 2_000)
		};
	}
	return config;
}

export interface LoadConfigOptions {
	/** OS keychain, when one is available on this host. */
	secrets?: SecretStore | null;
	logger?: Logger;
	/** Clock for the stray-temp sweep. */
	now?: () => number;
}

/**
 * Why a config file that EXISTS cannot be used, when the reason looks like a
 * torn or damaged write rather than a deliberate state: null for a file that
 * parses as JSON (including `{}`, what `clearConfig` leaves behind when it
 * cannot remove the file), which must never be "recovered" into an enrollment.
 */
function damageOf(raw: string): string | null {
	if (!raw.trim()) return 'is empty';
	try {
		JSON.parse(raw);
		return null;
	} catch {
		return 'is not valid JSON (a write was cut short)';
	}
}

/** The last-good copy, parsed; null when there is none or it is unusable too. Never throws. */
async function readBackup(fs: ConfigFileSystem, filePath: string): Promise<NodeConfig | null> {
	try {
		return parseConfig(await fs.readFile(configBackupPath(filePath)));
	} catch {
		return null;
	}
}

/**
 * Read the stored config and rehydrate its credential.
 *
 * A `keychain`-backed config whose secret has vanished from the OS
 * store (keychain reset, profile migrated, entry revoked by hand) reads
 * as NOT ENROLLED rather than as a config with an empty secret: a node
 * that keeps beating with a blank credential would just hammer the API
 * for 401s until someone noticed.
 *
 * A config that exists but is EMPTY, unreadable or not valid JSON (a torn
 * write) is recovered from the last-good copy {@link configBackupPath}, with
 * a WARN naming it. Reading never writes: the next save rewrites the config
 * from what was recovered. A MISSING config is never recovered, since that
 * is what unenrolling (or deleting it by hand) means. Temp files a killed
 * write left beside the config are never read; stale ones are removed.
 */
export async function loadConfig(
	fs: ConfigFileSystem,
	filePath: string,
	options: LoadConfigOptions = {}
): Promise<NodeConfig | null> {
	await sweepStaleTempFiles(fs, filePath, { now: options.now?.() ?? Date.now() });

	let raw: string | null = null;
	let damage: string | null = null;
	try {
		raw = await fs.readFile(filePath);
		if (raw !== null) damage = damageOf(raw);
	} catch (error) {
		damage = `could not be read (${error instanceof Error ? error.message : String(error)})`;
	}

	let config: NodeConfig | null;
	if (damage) {
		config = await readBackup(fs, filePath);
		if (!config) return null;
		options.logger?.warn(
			`The node config ${filePath} ${damage}; recovered it from the last good copy ${configBackupPath(
				filePath
			)}. The next change to the config (enroll, pause, resume, policy) rewrites ${filePath}.`
		);
	} else {
		config = parseConfig(raw);
	}
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
	const content = `${JSON.stringify(stored, null, '\t')}\n`;
	const secretOnDisk = stored.secretStorage !== 'keychain';
	const restrictOptions = {
		platform: options.platform,
		secretOnDisk,
		...(options.logger ? { logger: options.logger } : {})
	};

	if (!supportsAtomicWrites(fs)) {
		// A test double without the atomic primitives: the in-place write.
		await fs.writeFile(filePath, content);
		await restrictConfigFile(fs, filePath, restrictOptions);
		return;
	}

	// The temp file is tightened while still EMPTY, so the credential only
	// ever lands in an owner-only file; the rename then carries that
	// protection over to the config (see `atomic-state-file.ts`). A temp file
	// that cannot be PROVEN owner-only never becomes the config (it would
	// replace an owner-only file with an inherited ACL): the save falls back to
	// rewriting the existing file in place, which keeps its current ACL.
	let ownerOnly = false;
	const written = await replaceOrRewrite(
		fs,
		filePath,
		content,
		{
			platform: options.platform,
			tighten: async (tempPath) => {
				// Quiet: a failure here is reported once, by the in-place path below.
				if (!(await restrictConfigFile(fs, tempPath, { platform: options.platform, secretOnDisk: false }))) {
					throw new TempNotOwnerOnlyError(tempPath);
				}
				ownerOnly = true;
			}
		},
		(error) => {
			if (error instanceof TempNotOwnerOnlyError) return;
			const detail = error instanceof Error ? error.message : String(error);
			options.logger?.warn(
				`Could not replace the node config ${filePath} atomically (${options.logger.redact(
					detail
				)} — another program may be holding it open); rewrote it in place instead.`
			);
		}
	);
	if (written === 'in-place') {
		// The previous behaviour exactly: the existing file (with its current
		// ACL) is rewritten, then tightened, loudly when that fails.
		ownerOnly = await restrictConfigFile(fs, filePath, restrictOptions);
	}
	await refreshBackup(fs, filePath, content, {
		platform: options.platform,
		ownerOnly,
		...(options.logger ? { logger: options.logger } : {})
	});
}

/**
 * Write the last-good copy AFTER the config itself, so a kill between the two
 * leaves the newer config and an older copy, never the reverse.
 *
 * It only ever exists owner-only, so it never widens anything. When the
 * config itself could not be proven owner-only (its tightening failed and
 * was reported), no copy is made, and a stale copy is removed so a later
 * recovery cannot bring back an older config. A copy that cannot be made
 * owner-only, or fails to write, is removed for the same reason. There is no
 * in-place fallback for it.
 */
async function refreshBackup(
	fs: ConfigFileSystem & AtomicFileOps,
	filePath: string,
	content: string,
	options: { platform?: string; ownerOnly: boolean; logger?: Logger }
): Promise<void> {
	const backupPath = configBackupPath(filePath);
	if (!options.ownerOnly) {
		await fs.remove(backupPath).catch(() => undefined);
		return;
	}
	try {
		await replaceFileAtomically(fs, backupPath, content, {
			platform: options.platform,
			tighten: async (tempPath) => {
				if (!(await restrictConfigFile(fs, tempPath, { platform: options.platform, secretOnDisk: false }))) {
					throw new Error('the copy could not be made owner-only');
				}
			}
		});
	} catch (error) {
		await fs.remove(backupPath).catch(() => undefined);
		const detail = error instanceof Error ? error.message : String(error);
		options.logger?.warn(
			`Could not refresh the last good copy of the node config (${backupPath}): ${options.logger.redact(detail)}`
		);
	}
}

/**
 * Tighten the config file to owner-only on any platform.
 *
 * Windows gets a real ACL through `fs.restrict` rather than the old
 * silent skip; POSIX gets the 0600 chmod. When the credential is on
 * disk and the tightening fails, the operator is TOLD — that is the
 * only remaining thing standing between the secret and every other
 * process on the machine.
 *
 * Never throws; resolves true when the file was proven owner-only.
 */
export async function restrictConfigFile(
	fs: ConfigFileSystem,
	filePath: string,
	options: {
		platform?: string;
		secretOnDisk: boolean;
		logger?: Logger;
		/** The path a warning names, when `filePath` is the temp file staged for it. */
		displayPath?: string;
	}
): Promise<boolean> {
	const shown = options.displayPath ?? filePath;
	const loud = (message: string): void => {
		if (options.secretOnDisk) {
			options.logger?.warn(message);
		}
	};

	if (options.platform === 'win32') {
		if (!fs.restrict) {
			loud(
				`Could not apply an owner-only ACL to ${shown} on this host — the node credential is readable by anything the inherited ACL admits.`
			);
			return false;
		}
		try {
			await fs.restrict(filePath);
			return true;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			loud(`Could not apply an owner-only ACL to ${shown}: ${detail}`);
			return false;
		}
	}

	try {
		await fs.chmod(filePath, CONFIG_FILE_MODE);
		return true;
	} catch (error) {
		// Some filesystems (CIFS, FAT, container overlays) genuinely
		// cannot do this. The write still stands — but say so.
		const detail = error instanceof Error ? error.message : String(error);
		loud(`Could not set 0600 on ${shown}: ${detail}`);
		return false;
	}
}

/**
 * Erase every local trace of an enrollment: the keychain entry first
 * (the credential itself), then the files.
 *
 * Deleting the credential before the file is deliberate — a crash
 * between the two leaves a config whose secret is gone, which reads as
 * "not enrolled" and sends the operator back through `enroll`. The
 * other order would leave a live credential behind with nothing
 * pointing at it.
 *
 * The last-good copy goes BEFORE the config, so a crash between the two
 * leaves an enrolled config (as before), never a missing config beside a
 * copy of it. Temp files a killed save left behind may hold the credential
 * too; however recent, they go with the enrollment.
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
	await eraseFile(fs, configBackupPath(filePath));
	await sweepStaleTempFiles(fs, filePath, { olderThanMs: 0 });
	await eraseFile(fs, filePath);
}

/**
 * Remove a file, or, when that is not possible, overwrite it with an empty
 * object so the credential is gone even if the file itself survives.
 */
async function eraseFile(fs: ConfigFileSystem, filePath: string): Promise<void> {
	if (fs.remove) {
		try {
			await fs.remove(filePath);
			return;
		} catch {
			// Fall through to the overwrite below.
		}
	}
	await writeStateFile(fs, filePath, '{}\n');
}
