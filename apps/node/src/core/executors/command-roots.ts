import { promises as fs } from 'fs';
import { isAbsolute, resolve } from 'path';
import { FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN, isReservedMountDir } from '@ever-works/contracts';
import type { FleetTaskWorkspaceMountDescriptor } from '@ever-works/contracts';

/**
 * WHERE a command runs — the mount resolver (EW-807, slice AA).
 *
 * ## The defect this closes
 *
 * A multi-repo Task workspace provisions each extra repository as its OWN
 * worktree beneath the fleet root and links it into the primary at
 * `.mounts/<dir>`. The model is granted every writable mount and happily
 * edits all of them. But every command the node ran — steps and
 * acceptance checks alike — was handed `descriptor.path`, the PRIMARY
 * worktree, and nothing else. A run could change three repositories and
 * only ever test one, then open three pull requests and report a green
 * gate. That is worse than no gate: it is a gate that says the wrong
 * thing.
 *
 * Nor could a check reach a mount by hand. `.mounts/<dir>` is a junction
 * (Windows) / directory symlink (POSIX), and `resolveStepCwd` refuses a
 * symlink outright — correctly, because following one is how a `cwd`
 * escapes a sandbox. Even with the symlink allowed, a mount's real
 * worktree is a COUSIN of the primary under the fleet root, not a
 * descendant, so the canonical-descendant re-check would refuse it too.
 * There was no path at all.
 *
 * ## The rule this module enforces
 *
 * A command names a repository by its `mountDir` — a NAME, one path
 * segment, the same handle the workspace spec used. The name is resolved
 * by LOOKING IT UP in the descriptor this run's provisioner returned. It
 * is never joined onto a directory, never concatenated, never used to
 * build a path at all.
 *
 * That matters because the name is attacker-influenceable: it can come
 * from a repository-declared check (`.works/works.yml`), and the model
 * has write access to the checkout. A lookup can only ever return a
 * worktree this run actually provisioned; a join can return anything a
 * string can describe.
 *
 * Containment is then PROVED rather than assumed — see
 * {@link resolveCommandRoot}. The descriptor's contract says `path` is
 * absolute and canonical, but "the contract says so" is not a property
 * the filesystem enforces, and this value becomes a `cwd` for a shell on
 * a machine holding the owner's credentials.
 */

/** The mount fields this module needs; the real descriptor carries more. */
export type CommandRootMount = Pick<FleetTaskWorkspaceMountDescriptor, 'mountDir' | 'path'>;

/** Filesystem seam, so the containment proofs are testable without a real link farm. */
export interface CommandRootFs {
	lstat: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
	realpath: (path: string) => Promise<string>;
}

export const defaultCommandRootFs: CommandRootFs = {
	lstat: (path) => fs.lstat(path),
	realpath: (path) => fs.realpath(path)
};

/**
 * A command named a repository the node will not run it in. Always a
 * REFUSAL that fails the job, never a silent fall back to the primary
 * worktree: "we could not find the repository you asked us to test, so we
 * tested a different one and called it green" is precisely the class of
 * answer this slice exists to delete.
 */
export class CommandRootError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CommandRootError';
	}
}

/** Case-folded on win32, where two spellings of one path are one path. */
function sameFilesystemPath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const resolved = resolve(value);
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}

/**
 * Resolve the root directory one command runs in.
 *
 * `undefined` / empty `mountDir` is the primary worktree — what every
 * command did before this field existed, so nothing changes for a
 * single-repository run or for any check authored before EW-807.
 *
 * Otherwise, five gates, in this order, each of which can only NARROW:
 *
 *  1. **Shape.** The name must satisfy
 *     `FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN` and not be a reserved
 *     directory. One segment; no `/`, no `\`, no `..`, no drive letter,
 *     no `.git` / `.mounts` / `node_modules`, no Windows device name.
 *     A traversal string is refused here, before it is compared to
 *     anything, so the later gates never see one.
 *  2. **Membership.** The name must match, case-insensitively, the
 *     `mountDir` of a mount THIS RUN PROVISIONED. The answer is the
 *     descriptor's own `path`; nothing is built from the input string.
 *     A run with no mounts admits no `mountDir` at all.
 *  3. **Absolute.** The descriptor's path must be absolute — a relative
 *     one would resolve against whatever directory the node service was
 *     started in.
 *  4. **Not a link.** `lstat` must report a real directory. This is what
 *     catches a descriptor carrying `linkPath` (`<primary>/.mounts/<dir>`)
 *     instead of `path`: that IS a junction, and running a command
 *     through it would defeat every containment check downstream. It also
 *     catches a link planted between provisioning and use.
 *  5. **Canonical.** `realpath` must resolve to the same place. A path
 *     whose PARENT was swapped for a link after provisioning fails here
 *     even though its final component is a real directory.
 *
 * The returned path is the canonical one, so `resolveStepCwd` then
 * applies its own strict-descendant proof against a root that has already
 * been proved.
 */
export async function resolveCommandRoot(
	mountDir: string | undefined | null,
	primaryPath: string,
	mounts: readonly CommandRootMount[] | undefined | null,
	fsApi: CommandRootFs = defaultCommandRootFs
): Promise<string> {
	const wanted = typeof mountDir === 'string' ? mountDir.trim() : '';
	if (!wanted) return primaryPath;

	if (!FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN.test(wanted) || isReservedMountDir(wanted)) {
		throw new CommandRootError(
			`Command names repository '${wanted}', which is not a valid mount directory name (one segment; no separators, no traversal, no reserved name)`
		);
	}

	const provisioned = mounts ?? [];
	// Case-insensitive, like every other mountDir comparison in the fleet:
	// this runs on Windows and macOS, where `api` and `API` are one
	// directory, and the provisioner already refuses two mounts that
	// differ only by case.
	const key = wanted.toLowerCase();
	const mount = provisioned.find(
		(candidate) => typeof candidate?.mountDir === 'string' && candidate.mountDir.toLowerCase() === key
	);
	if (!mount) {
		const names = provisioned.map((candidate) => candidate.mountDir).filter(Boolean);
		throw new CommandRootError(
			`Command names repository '${wanted}', which this run did not provision` +
				(names.length > 0 ? ` (provisioned: ${names.join(', ')})` : ' (this run provisioned no mounts)')
		);
	}

	const candidate = typeof mount.path === 'string' ? mount.path.trim() : '';
	if (!candidate || !isAbsolute(candidate)) {
		throw new CommandRootError(`Mount '${wanted}' has no absolute path on this node`);
	}

	let canonical: string;
	try {
		const stats = await fsApi.lstat(candidate);
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new Error('link or non-directory');
		}
		canonical = await fsApi.realpath(candidate);
	} catch {
		throw new CommandRootError(`Mount '${wanted}' is missing, linked, or not a directory on this node`);
	}
	if (!sameFilesystemPath(canonical, candidate)) {
		throw new CommandRootError(`Mount '${wanted}' resolves through a link on this node`);
	}
	return canonical;
}
