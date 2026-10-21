import { createHash } from 'crypto';
import * as nodePath from 'path';
import {
	isFleetFileName,
	makeFleetLinkError,
	type FleetFileRootKind,
	type FleetFileRootView,
	type FleetLinkError,
	type FleetLinkErrorCode
} from '@ever-works/contracts';
import { isInsideRoot, type AllowedRoot } from '../../allowed-roots';
import type { FilesIo, FilesStat } from './files-io';

/**
 * Files on computers (FL-11, plan §3 "Path canonicalisation", T-02) — the
 * per-request half of "inside a root", over the ONE resolver
 * (`../../allowed-roots`, CONTRACTS R-39): that module answers which folders
 * are roots and whether a canonical path sits under one; this one turns a
 * request (`{ root, path }`, then a name) into a real path on this machine, or
 * a typed refusal:
 *
 *  - the folder is `realpath`-ed whole — every link and junction on the way
 *    resolved — then proved to sit under its root, so `..`, an absolute path,
 *    a drive letter (already refused by the contract's normaliser) and a link
 *    from the root to `/etc` all read `invalid` "That path leaves its root";
 *  - an ENTRY in that folder is never followed: its own `lstat` says what it
 *    is, and a link is described (inside the root or not), never opened here.
 *
 * Never a second definition of "inside a root" (`isInsideRoot` is the one).
 */

export const LEAVES_ROOT_HINT = 'That path leaves its root';

/** A refusal the module turns into `{ error }` (CONTRACTS §8). */
export class FilesRequestError extends Error {
	constructor(
		readonly code: FleetLinkErrorCode,
		hint: string,
		readonly details?: Record<string, unknown>
	) {
		super(hint);
		this.name = 'FilesRequestError';
	}

	toLinkError(): FleetLinkError {
		return makeFleetLinkError(this.code, this.message, this.details);
	}
}

export function filesPathApi(platform: string): typeof nodePath.posix {
	return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** A stable id per canonical root path (what a `files` channel opens with). */
export function fleetFileRootId(path: string, platform: string): string {
	const key = platform === 'win32' ? path.toLowerCase() : path;
	return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

const VIEW_KIND: Record<AllowedRoot['kind'], FleetFileRootKind> = {
	checkout: 'checkout',
	workspace: 'workspace',
	'files-root': 'listed',
	'log-dir': 'listed'
};

/** The roots as the platform lists them. */
export function describeFileRoots(roots: readonly AllowedRoot[], platform: string): FleetFileRootView[] {
	const api = filesPathApi(platform);
	return roots.map((root) => ({
		id: fleetFileRootId(root.path, platform),
		kind: VIEW_KIND[root.kind],
		label: root.kind === 'checkout' ? api.basename(root.path) || root.path : root.path,
		path: root.path
	}));
}

export function findFileRoot(roots: readonly AllowedRoot[], id: string, platform: string): AllowedRoot | null {
	return roots.find((root) => fleetFileRootId(root.path, platform) === id) ?? null;
}

/**
 * One name this machine accepts: the contract's rule (no separator, no `..`,
 * no control character) plus, on Windows, no `:` (an alternate data stream)
 * and none of `*?"<>|`, and no trailing dot or space.
 */
export function isAcceptableFileName(name: unknown, platform: string): name is string {
	if (!isFleetFileName(name)) return false;
	if (platform === 'win32') {
		if (/[:*?"<>|]/.test(name)) return false;
		if (/[. ]$/.test(name)) return false;
	}
	return true;
}

/**
 * The real path of the folder `rel` (`/`-separated, already normalised by the
 * contract) under `root`, after every link on the way was resolved; refused
 * when it is gone (`not_found`), leaves the root (`invalid`) or is not a folder.
 */
export async function resolveFolder(io: FilesIo, root: AllowedRoot, rel: string): Promise<string> {
	const api = filesPathApi(io.platform);
	const segments = rel.length === 0 ? [] : rel.split('/');
	for (const segment of segments) {
		if (!isAcceptableFileName(segment, io.platform)) throw new FilesRequestError('invalid', LEAVES_ROOT_HINT);
	}
	const candidate = segments.length === 0 ? root.path : api.join(root.path, ...segments);
	let real: string;
	try {
		real = await io.realpath(candidate);
	} catch {
		throw new FilesRequestError('not_found', `${segments[segments.length - 1] ?? 'That folder'} is gone`);
	}
	if (!isInsideRoot(real, root.path, io.platform)) throw new FilesRequestError('invalid', LEAVES_ROOT_HINT);
	let stat: FilesStat;
	try {
		stat = await io.stat(real);
	} catch {
		throw new FilesRequestError('not_found', `${segments[segments.length - 1] ?? 'That folder'} is gone`);
	}
	if (stat.kind !== 'folder')
		throw new FilesRequestError('invalid', `${segments[segments.length - 1]} is not a folder`);
	return real;
}

/** An entry of a resolved folder, not followed: its absolute path and what it is. */
export async function resolveEntry(
	io: FilesIo,
	folderReal: string,
	name: string
): Promise<{ path: string; stat: FilesStat }> {
	if (!isAcceptableFileName(name, io.platform)) throw new FilesRequestError('invalid', LEAVES_ROOT_HINT);
	const path = filesPathApi(io.platform).join(folderReal, name);
	try {
		return { path, stat: await io.lstat(path) };
	} catch {
		throw new FilesRequestError('not_found', `${name} is gone`);
	}
}

/**
 * Where a link at `path` points, when that stays inside `root`: its real path
 * and kind. Null for a broken link; `inside: false` for one that leaves.
 */
export async function describeLink(
	io: FilesIo,
	root: AllowedRoot,
	path: string
): Promise<{ inside: boolean; real: string; kind: FilesStat['kind'] } | null> {
	let real: string;
	try {
		real = await io.realpath(path);
	} catch {
		return null;
	}
	if (!isInsideRoot(real, root.path, io.platform)) return { inside: false, real, kind: 'other' };
	try {
		return { inside: true, real, kind: (await io.stat(real)).kind };
	} catch {
		return null;
	}
}
