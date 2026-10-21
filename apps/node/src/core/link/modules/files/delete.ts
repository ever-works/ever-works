import { FLEET_FILES_LIMITS } from '@ever-works/contracts';
import type { FilesIo } from './files-io';
import { FilesRequestError, resolveEntry } from './path-guard';

/**
 * Files on computers (FL-11, T-06) — `files.delete`: remove entries of a
 * resolved folder. Each name is checked on its own (`resolveEntry`: a plain
 * name of THIS folder, never followed), so a link is removed as a link and
 * its target — inside the root or not — is never touched. No shell-out:
 * `fs.rm` recursive. The confirmation (`confirm-destructive`, the typed
 * name) is the platform's (CONTRACTS §2.2); the machine does what it was
 * asked only inside its roots.
 */
export async function deleteEntries(
	io: FilesIo,
	folderReal: string,
	names: readonly string[]
): Promise<{ removed: number }> {
	const unique = [...new Set(names)];
	if (unique.length === 0) throw new FilesRequestError('invalid', 'Select at least one item');
	if (unique.length > FLEET_FILES_LIMITS.maxEntries) {
		throw new FilesRequestError('limit_exceeded', 'Select fewer than 5,000 items');
	}
	// Every name is proved first: one bad name refuses the whole request before anything is removed.
	const targets: string[] = [];
	for (const name of unique) targets.push((await resolveEntry(io, folderReal, name)).path);
	let removed = 0;
	for (const target of targets) {
		try {
			await io.remove(target);
			removed += 1;
		} catch (error) {
			throw new FilesRequestError(
				'operation_failed',
				(error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0].slice(0, 300),
				{ removed }
			);
		}
	}
	return { removed };
}
