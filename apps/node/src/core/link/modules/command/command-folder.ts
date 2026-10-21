import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { expandHome } from '../../../sessions/owner-session-launcher';

/**
 * Commands on computers (FL-12, plan §11, lane-log decision 6) — the folder a
 * command runs in: the machine owner's home folder by default, else a folder
 * inside home or inside a folder the machine's owner allowed (the owner
 * sessions' rule, FL-04 decision 10). Canonicalised (`~` expanded, symlinks
 * resolved), compared without case on Windows; anything else is refused
 * `invalid` naming the path. R-39's shared `allowed-roots.ts` replaces the
 * roots here once it exists.
 */

export interface CommandFolderInput {
	/** As asked; absent = home. */
	cwd?: string;
	homedir: string;
	platform: string;
	extraRoots?: readonly string[];
	nodeName: string;
	realpath?: (target: string) => Promise<string>;
}

export interface CommandFolderResult {
	cwd: string | null;
	error: { code: 'invalid'; hint: string } | null;
}

function isWithin(child: string, parent: string, platform: string): boolean {
	const paths = platform === 'win32' ? path.win32 : path.posix;
	const relative = paths.relative(
		platform === 'win32' ? parent.toLowerCase() : parent,
		platform === 'win32' ? child.toLowerCase() : child
	);
	return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative));
}

export async function resolveCommandFolder(input: CommandFolderInput): Promise<CommandFolderResult> {
	const realpath = input.realpath ?? ((target: string) => fsp.realpath(target));
	const asked = input.cwd?.trim() ? input.cwd.trim() : '~';
	const requested = expandHome(asked, input.homedir, input.platform);
	const absolute = input.platform === 'win32' ? path.win32.isAbsolute(requested) : path.posix.isAbsolute(requested);
	if (!absolute) {
		return { cwd: null, error: { code: 'invalid', hint: `${asked} is not a full path on ${input.nodeName}` } };
	}
	let cwd: string;
	try {
		cwd = await realpath(requested);
	} catch {
		return { cwd: null, error: { code: 'invalid', hint: `${asked} does not exist on ${input.nodeName}` } };
	}
	const roots: string[] = [];
	for (const root of [input.homedir, ...(input.extraRoots ?? [])]) {
		try {
			roots.push(await realpath(root));
		} catch {
			// a root that does not exist admits nothing
		}
	}
	if (!roots.some((root) => isWithin(cwd, root, input.platform))) {
		return {
			cwd: null,
			error: {
				code: 'invalid',
				hint: `${asked} is outside your home folder on ${input.nodeName}; commands run in your home folder or a folder the machine's owner allowed`
			}
		};
	}
	return { cwd, error: null };
}
