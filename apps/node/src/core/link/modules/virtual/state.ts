import { mkdir, readFile, readdir, rm, writeFile, chmod, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { isFleetVirtualSystemId, type FleetVirtualKind, type FleetVirtualSystemId } from '@ever-works/contracts';
import { parseCatalogueLock, type VirtualCatalogueLock } from './catalogue';
import { isChildNodeId } from './docker-args';

/**
 * Virtual computers (FL-16, plan §6.1 `state.ts`) — what the HOST keeps about
 * its children, under its virtual data folder (`<config dir>/virtual`):
 *
 *   <root>/catalogue.lock.json      the digest each system was pinned to here
 *   <root>/<childId>/meta.json      name, system, kind, size, image, created at
 *   <root>/<childId>/run/bootstrap.sh   (mounted read-only into the child)
 *
 * Never a password or a token: the guest's token goes straight into the guest
 * (`docker exec -i`), and a Windows VM's password (phase 2) lives in the OS
 * keychain. Every path is built from a validated child id, so nothing outside
 * `<root>/<childId>/` is ever written or removed for a child.
 */

export interface VirtualChildMeta {
	childNodeId: string;
	name: string;
	systemId: FleetVirtualSystemId;
	kind: FleetVirtualKind;
	cpus: number;
	memoryGiB: number;
	diskGiB: number | null;
	image: { ref: string; digest: string | null } | null;
	createdAt: string;
}

/** The file operations the state needs (injected so tests run without a disk). */
export interface VirtualStateFs {
	mkdir(path: string): Promise<void>;
	readFile(path: string): Promise<string | null>;
	writeFile(path: string, content: string, mode: number): Promise<void>;
	/** Remove a folder and everything in it; missing is success. */
	removeDir(path: string): Promise<void>;
	listDir(path: string): Promise<string[]>;
	/** Remove one file; missing is success. */
	removeFile(path: string): Promise<void>;
	/** Whether a file exists (the Windows markers in the shared folder). */
	exists(path: string): Promise<boolean>;
}

export const defaultVirtualStateFs: VirtualStateFs = {
	mkdir: async (path) => {
		await mkdir(path, { recursive: true, mode: 0o700 });
	},
	readFile: async (path) => {
		try {
			return await readFile(path, 'utf8');
		} catch {
			return null;
		}
	},
	writeFile: async (path, content, mode) => {
		await writeFile(path, content, { encoding: 'utf8', mode });
		// `mode` applies only when the file is created; make an existing one match.
		await chmod(path, mode).catch(() => undefined);
	},
	removeDir: async (path) => {
		await rm(path, { recursive: true, force: true });
	},
	listDir: async (path) => {
		try {
			return await readdir(path);
		} catch {
			return [];
		}
	},
	removeFile: async (path) => {
		await unlink(path).catch((error: NodeJS.ErrnoException) => {
			if (error?.code !== 'ENOENT') throw error;
		});
	},
	exists: async (path) => {
		try {
			await readFile(path);
			return true;
		} catch (error) {
			// A file the guest's share wrote as another user may be unreadable but present.
			return (error as NodeJS.ErrnoException)?.code === 'EACCES';
		}
	}
};

export class VirtualState {
	constructor(
		/** Absolute POSIX path of the virtual data folder. */
		readonly root: string,
		private readonly fs: VirtualStateFs = defaultVirtualStateFs
	) {
		if (!root.startsWith('/')) throw new Error('the virtual data folder must be an absolute path');
	}

	childDir(childNodeId: string): string {
		if (!isChildNodeId(childNodeId)) throw new Error('a virtual computer id must be a uuid');
		return posix.join(this.root, childNodeId.toLowerCase());
	}

	runDir(childNodeId: string): string {
		return posix.join(this.childDir(childNodeId), 'run');
	}

	/** Windows VMs: the first-boot step, mounted read-only as the installer's `/oem`. */
	oemDir(childNodeId: string): string {
		return posix.join(this.childDir(childNodeId), 'oem');
	}

	/** Windows VMs: the folder shared with the guest (its markers, the one-time token file). */
	sharedDir(childNodeId: string): string {
		return posix.join(this.childDir(childNodeId), 'shared');
	}

	/** Windows VMs: create `run/`, `oem/` (with the first-boot files) and `shared/`. */
	async prepareWindows(childNodeId: string, files: { installBat: string; firstBoot: string }): Promise<void> {
		await this.fs.mkdir(this.runDir(childNodeId));
		await this.fs.mkdir(this.oemDir(childNodeId));
		await this.fs.mkdir(this.sharedDir(childNodeId));
		await this.fs.writeFile(posix.join(this.oemDir(childNodeId), 'install.bat'), files.installBat, 0o644);
		await this.fs.writeFile(
			posix.join(this.oemDir(childNodeId), 'ever-works-first-boot.ps1'),
			files.firstBoot,
			0o644
		);
	}

	/** Write a private (0600) file in the child's folder; answers its path. */
	async writePrivate(childNodeId: string, relative: string, content: string): Promise<string> {
		const path = posix.join(this.childDir(childNodeId), relative);
		await this.fs.writeFile(path, content, 0o600);
		return path;
	}

	async removeFile(path: string): Promise<void> {
		await this.fs.removeFile(path);
	}

	async exists(path: string): Promise<boolean> {
		return this.fs.exists(path);
	}

	/** Create the child's folders (0700) and write its bootstrap (0644 — read by the guest's root). */
	async prepare(childNodeId: string, bootstrap: string): Promise<void> {
		await this.fs.mkdir(this.runDir(childNodeId));
		await this.fs.writeFile(posix.join(this.runDir(childNodeId), 'bootstrap.sh'), bootstrap, 0o644);
	}

	async writeMeta(meta: VirtualChildMeta): Promise<void> {
		await this.fs.mkdir(this.childDir(meta.childNodeId));
		await this.fs.writeFile(
			posix.join(this.childDir(meta.childNodeId), 'meta.json'),
			`${JSON.stringify(meta, null, 2)}\n`,
			0o600
		);
	}

	async readMeta(childNodeId: string): Promise<VirtualChildMeta | null> {
		const raw = await this.fs.readFile(posix.join(this.childDir(childNodeId), 'meta.json'));
		return parseChildMeta(raw);
	}

	/** Every child this machine keeps a folder for. */
	async listChildIds(): Promise<string[]> {
		return (await this.fs.listDir(this.root)).filter((entry) => isChildNodeId(entry));
	}

	/** Remove exactly `<root>/<childId>/` (spec S5: nothing outside it is touched). */
	async removeChild(childNodeId: string): Promise<void> {
		await this.fs.removeDir(this.childDir(childNodeId));
	}

	async readLock(): Promise<VirtualCatalogueLock> {
		return parseCatalogueLock(await this.fs.readFile(posix.join(this.root, 'catalogue.lock.json')));
	}

	async writeLock(lock: VirtualCatalogueLock): Promise<void> {
		await this.fs.mkdir(this.root);
		await this.fs.writeFile(
			posix.join(this.root, 'catalogue.lock.json'),
			`${JSON.stringify(lock, null, 2)}\n`,
			0o600
		);
	}
}

/** A `meta.json` off the disk, or null for anything that is not one. */
export function parseChildMeta(raw: string | null): VirtualChildMeta | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<VirtualChildMeta>;
		if (!value || typeof value !== 'object') return null;
		if (!isChildNodeId(value.childNodeId) || !isFleetVirtualSystemId(value.systemId)) return null;
		if (value.kind !== 'vm' && value.kind !== 'container') return null;
		return {
			childNodeId: value.childNodeId,
			name: typeof value.name === 'string' ? value.name : value.childNodeId,
			systemId: value.systemId,
			kind: value.kind,
			cpus: typeof value.cpus === 'number' ? value.cpus : 0,
			memoryGiB: typeof value.memoryGiB === 'number' ? value.memoryGiB : 0,
			diskGiB: typeof value.diskGiB === 'number' ? value.diskGiB : null,
			image:
				value.image && typeof value.image.ref === 'string'
					? {
							ref: value.image.ref,
							digest: typeof value.image.digest === 'string' ? value.image.digest : null
						}
					: null,
			createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString()
		};
	} catch {
		return null;
	}
}
