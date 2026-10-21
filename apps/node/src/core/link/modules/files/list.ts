import {
	FLEET_FILES_LIMITS,
	isCredentialShapedName,
	joinFleetFilePath,
	type FleetFileConflictView,
	type FleetFileEntryView,
	type FleetFilesListResult
} from '@ever-works/contracts';
import type { AllowedRoot } from '../../allowed-roots';
import type { FilesIo } from './files-io';
import { describeLink, filesPathApi, isAcceptableFileName, resolveEntry } from './path-guard';

/**
 * Files on computers (FL-11, T-04) — `files.list`, `files.stat` and
 * `files.conflicts` on a resolved folder:
 *
 *  - names are read with `readdir`, hidden ones (a leading `.`, on every
 *    system — plan §6.2: the Windows hidden attribute and macOS `UF_HIDDEN`
 *    need native calls the node does not make; lane log decision 4) dropped
 *    unless asked for, sorted by name, and the first 5 000 described
 *    (`truncated` says when there were more — FR-6);
 *  - each entry is `lstat`-ed, never followed; a link says whether its target
 *    stays inside the root (and, when it does, what it points to, so a folder
 *    link opens) — FR-5;
 *  - credential-shaped names are flagged with the contract's one list (FR-8).
 */

const DESCRIBE_CONCURRENCY = 32;

export function compareFileNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

export async function describeFileEntry(
	io: FilesIo,
	root: AllowedRoot,
	folderReal: string,
	relFolder: string,
	name: string
): Promise<FleetFileEntryView | null> {
	let resolved;
	try {
		resolved = await resolveEntry(io, folderReal, name);
	} catch {
		return null; // gone between readdir and lstat, or a name this machine refuses
	}
	const { path, stat } = resolved;
	const entry: FleetFileEntryView = {
		name,
		kind: stat.kind,
		size: stat.kind === 'file' ? stat.size : 0,
		modifiedAt: stat.mtimeMs > 0 ? new Date(stat.mtimeMs).toISOString() : null,
		hidden: name.startsWith('.'),
		credentialShaped: isCredentialShapedName(name, joinFleetFilePath(relFolder, name)),
		linkInsideRoot: null
	};
	if (stat.kind === 'link') {
		const link = await describeLink(io, root, path);
		if (link) {
			entry.linkInsideRoot = link.inside;
			if (link.inside && link.kind !== 'link') entry.linkKind = link.kind;
		}
	}
	return entry;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return out;
}

export async function listFolder(
	io: FilesIo,
	root: AllowedRoot,
	folderReal: string,
	relFolder: string,
	options: { hidden: boolean }
): Promise<FleetFilesListResult> {
	const names = (await io.readdir(folderReal))
		.filter((name) => options.hidden || !name.startsWith('.'))
		.sort(compareFileNames);
	const shown = names.slice(0, FLEET_FILES_LIMITS.maxEntries);
	const described = await mapLimited(shown, DESCRIBE_CONCURRENCY, (name) =>
		describeFileEntry(io, root, folderReal, relFolder, name)
	);
	return {
		entries: described.filter((entry): entry is FleetFileEntryView => entry !== null),
		truncated: names.length > shown.length,
		total: names.length
	};
}

/** The same-name entries in the folder (FR-12): what an upload or copy would meet. */
export async function findConflicts(
	io: FilesIo,
	folderReal: string,
	names: readonly string[]
): Promise<FleetFileConflictView[]> {
	const api = filesPathApi(io.platform);
	const wanted = [...new Set(names.filter((name) => isAcceptableFileName(name, io.platform)))].slice(
		0,
		FLEET_FILES_LIMITS.maxEntries
	);
	const found = await mapLimited(wanted, DESCRIBE_CONCURRENCY, async (name) => {
		try {
			const stat = await io.lstat(api.join(folderReal, name));
			const conflict: FleetFileConflictView = {
				name,
				kind: stat.kind,
				size: stat.kind === 'file' ? stat.size : 0,
				modifiedAt: stat.mtimeMs > 0 ? new Date(stat.mtimeMs).toISOString() : null
			};
			return conflict;
		} catch {
			return null;
		}
	});
	return found.filter((conflict): conflict is FleetFileConflictView => conflict !== null);
}
