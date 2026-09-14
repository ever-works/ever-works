import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Agent computers — each Agent's own profile on this machine.
 *
 * Every Agent that works on this machine gets ONE directory, keyed by the
 * (node, Agent) pair, holding its own browser profile (`browser/` — cookies,
 * signed-in sessions, site data) and its own file root (`files/` — where its
 * shell opens and its downloads land). No two Agents ever share one, and a
 * capture backend is only ever handed the directory of the Agent being
 * watched.
 *
 * The platform never learns a path. It hands the node an opaque
 * `profileKey`, and this module maps it to a directory the node chose:
 *
 *   <root>/<sha256(nodeId:agentId), 32 hex>/
 *     .profile-key        the key the directory was last created for
 *     browser/            the Agent's browser user-data directory
 *     files/              the Agent's file root
 *
 * The key is what makes an owner's reset real. Resetting an Agent's logins
 * on the platform mints a NEW key (and is refused while that Agent works on
 * this machine); the next time a view opens here with that key, the key on
 * disk no longer matches and this module deletes and recreates EXACTLY that
 * one directory. A sibling Agent's directory has a different name, so no
 * reset can reach it.
 *
 * All IO is injected, as everywhere else in node core.
 */

export const AGENT_PROFILE_ROOT_ENV = 'EVER_WORKS_NODE_AGENT_PROFILE_ROOT';
export const AGENT_PROFILE_KEY_FILE = '.profile-key';
const PROFILE_KEY_PATTERN = /^[0-9a-f]{16,64}$/;

export interface AgentProfileFs {
	mkdir(path: string): Promise<void>;
	/** Recursive, forced removal; resolves when the path is gone. */
	rm(path: string): Promise<void>;
	readTextFile(path: string): Promise<string | null>;
	writeTextFile(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Total bytes under a directory (best-effort; 0 when unreadable). */
	directorySize(path: string): Promise<number>;
}

export interface AgentProfilePaths {
	/** The pair's own directory. */
	dir: string;
	/** Browser user-data directory — the only profile a capture backend opens. */
	browserDir: string;
	/** The Agent's file root on this machine. */
	filesDir: string;
	/** True when this call created the directory (first use, or after a reset). */
	created: boolean;
	/** True when this call replaced a directory whose key the platform had rotated. */
	reset: boolean;
}

export class AgentProfileKeyError extends Error {
	constructor() {
		super('The live view carried no usable profile key');
		this.name = 'AgentProfileKeyError';
	}
}

/** Owner-only access could not be applied to a profile that requires it; nothing was left behind. */
export class AgentProfileAccessError extends Error {
	constructor(detail: string) {
		super(`The Agent's profile could not be restricted to this machine's owner: ${detail}`);
		this.name = 'AgentProfileAccessError';
	}
}

/** Where profile directories live: the env override, else `~/.ever-works/agent-profiles`. */
export function defaultAgentProfileRoot(
	env: Record<string, string | undefined> = process.env,
	home = homedir()
): string {
	const override = env[AGENT_PROFILE_ROOT_ENV]?.trim();
	return override ? override : join(home, '.ever-works', 'agent-profiles');
}

/** The directory name for one (node, Agent) pair — stable, opaque, never shared. */
export function agentProfileDirName(nodeId: string, agentId: string): string {
	return createHash('sha256').update(`${nodeId}:${agentId}`, 'utf8').digest('hex').slice(0, 32);
}

export interface AgentProfileManagerOptions {
	root: string;
	fs: AgentProfileFs;
	/** Owner-only access for a freshly created directory (icacls on Windows, 0700 elsewhere). */
	restrictToOwner?: (path: string) => Promise<void> | void;
	/**
	 * Fail closed when owner-only access cannot be applied — no
	 * `restrictToOwner` hook, or the hook failed: the half-created directory
	 * is removed and `ensure` throws {@link AgentProfileAccessError}. Required
	 * on Windows, where a directory has no mode bits and `mkdir`'s 0700 is
	 * silently ignored, so without an ACL a profile's cookies and files would
	 * be readable by other local accounts. Off by default because elsewhere
	 * the 0700 mode already restricts the directory.
	 */
	requireOwnerOnly?: boolean;
}

/**
 * The manager for a machine of the given `process.platform`: owner-only
 * access is REQUIRED on Windows (see
 * {@link AgentProfileManagerOptions.requireOwnerOnly}) and best-effort on top
 * of 0700 elsewhere.
 */
export function createAgentProfileManager(
	options: Omit<AgentProfileManagerOptions, 'requireOwnerOnly'> & { platform: string }
): AgentProfileManager {
	const { platform, ...rest } = options;
	return new AgentProfileManager({ ...rest, requireOwnerOnly: platform === 'win32' });
}

export class AgentProfileManager {
	/**
	 * The tail of each profile directory's queue. Every `ensure` for one
	 * directory runs after the previous one settled, so a view carrying an old
	 * key can never resume after a reset for the rotated key and write the old
	 * key back (which would make the next open delete the fresh profile
	 * again). One node process owns its profile root, so an in-process queue
	 * is the whole critical section.
	 */
	private readonly tails = new Map<string, Promise<void>>();

	constructor(private readonly options: AgentProfileManagerOptions) {}

	/** Resolve (creating lazily, resetting on a rotated key) the pair's directory. */
	async ensure(nodeId: string, agentId: string, profileKey: string): Promise<AgentProfilePaths> {
		if (typeof profileKey !== 'string' || !PROFILE_KEY_PATTERN.test(profileKey)) {
			throw new AgentProfileKeyError();
		}
		const dir = this.dirFor(nodeId, agentId);
		return this.serialized(dir, () => this.ensureLocked(dir, profileKey));
	}

	/** Bytes the pair's directory occupies (0 when it does not exist). */
	async diskBytes(nodeId: string, agentId: string): Promise<number> {
		const dir = this.dirFor(nodeId, agentId);
		if (!(await this.options.fs.exists(dir))) return 0;
		try {
			return Math.max(0, Math.floor(await this.options.fs.directorySize(dir)));
		} catch {
			return 0;
		}
	}

	private dirFor(nodeId: string, agentId: string): string {
		return join(this.options.root, agentProfileDirName(nodeId, agentId));
	}

	/** Reset check, directory creation and key publication — always inside the directory's queue. */
	private async ensureLocked(dir: string, profileKey: string): Promise<AgentProfilePaths> {
		const keyFile = join(dir, AGENT_PROFILE_KEY_FILE);
		const { fs } = this.options;
		let created = false;
		let reset = false;
		if (await fs.exists(dir)) {
			const storedKey = (await fs.readTextFile(keyFile))?.trim() ?? null;
			if (storedKey !== profileKey) {
				// The platform rotated this Agent's key: its owner reset its
				// logins and files. Delete and recreate THIS directory only.
				await fs.rm(dir);
				reset = storedKey !== null;
			}
		}
		if (!(await fs.exists(dir))) {
			await fs.mkdir(dir);
			try {
				await this.restrict(dir);
			} catch (error) {
				// Fail closed: nothing is ever stored in a directory other local
				// accounts could read. The key file was never written, so even a
				// removal that fails here is reset on the next open.
				await fs.rm(dir).catch(() => undefined);
				throw error;
			}
			created = true;
		}
		const browserDir = join(dir, 'browser');
		const filesDir = join(dir, 'files');
		await fs.mkdir(browserDir);
		await fs.mkdir(filesDir);
		// Published last: a key on disk means the directory was fully prepared.
		await fs.writeTextFile(keyFile, profileKey);
		return { dir, browserDir, filesDir, created, reset };
	}

	private async serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const run = previous.then(work);
		const tail = run.then(
			() => undefined,
			() => undefined
		);
		this.tails.set(key, tail);
		try {
			return await run;
		} finally {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}

	private async restrict(dir: string): Promise<void> {
		const { restrictToOwner, requireOwnerOnly } = this.options;
		if (!restrictToOwner) {
			if (requireOwnerOnly) {
				throw new AgentProfileAccessError('no owner-only access control is available on this machine');
			}
			return;
		}
		try {
			await restrictToOwner(dir);
		} catch (error) {
			if (requireOwnerOnly) {
				throw new AgentProfileAccessError(error instanceof Error ? error.message : String(error));
			}
			// Best-effort hardening where the 0700 mode already restricts the
			// directory: a machine whose ACL tool is missing still keeps
			// profiles in separate directories under the owner's home.
		}
	}
}

/** The real filesystem behind {@link AgentProfileFs}. Directories are created 0700. */
export function createAgentProfileFs(): AgentProfileFs {
	return {
		mkdir: async (path) => {
			await fsp.mkdir(path, { recursive: true, mode: 0o700 });
		},
		rm: async (path) => {
			await fsp.rm(path, { recursive: true, force: true });
		},
		readTextFile: async (path) => {
			try {
				return await fsp.readFile(path, 'utf8');
			} catch {
				return null;
			}
		},
		writeTextFile: async (path, content) => {
			await fsp.writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
		},
		exists: async (path) => {
			try {
				await fsp.access(path);
				return true;
			} catch {
				return false;
			}
		},
		directorySize: (path) => measureDirectory(path)
	};
}

/** Bounded recursive size walk: stops counting past a file budget rather than walking forever. */
async function measureDirectory(root: string, budget = { files: 200_000 }): Promise<number> {
	let total = 0;
	const stack = [root];
	while (stack.length > 0 && budget.files > 0) {
		const current = stack.pop() as string;
		let entries: import('fs').Dirent[];
		try {
			entries = await fsp.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile()) {
				budget.files -= 1;
				try {
					total += (await fsp.stat(full)).size;
				} catch {
					// vanished mid-walk
				}
			}
		}
	}
	return total;
}
