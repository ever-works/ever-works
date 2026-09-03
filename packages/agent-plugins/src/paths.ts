/**
 * Path containment — spec 4.1.
 *
 * "When a client discovers, reads, or executes a file or directory supplied
 * by the plugin package, the filesystem-resolved path MUST remain within the
 * filesystem-resolved plugin root. Symlinks, junctions, reparse points, and
 * equivalent filesystem mechanisms MAY resolve to targets within the plugin
 * root, but clients MUST reject package paths that resolve outside it."
 *
 * Two consequences shape this module:
 *
 *  - Comparison happens on *filesystem-resolved* paths, so both sides go
 *    through `realpath`. A lexical check alone would let a symlink out.
 *  - A target that does not exist yet still has to be checked (an MCP
 *    server's `cwd` under `PLUGIN_DATA`, a directory we are about to
 *    create), so we resolve the nearest existing ancestor and re-join the
 *    remainder.
 *
 * The failure *boundaries* of spec 4.1 — which of reject-package,
 * invalidate-component, skip-skill, invalidate-server or deny-path applies —
 * are the caller's decision, because only the caller knows what it was
 * resolving. This module answers one question: is it inside?
 */

import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/**
 * True when a configuration value is a plugin-relative path in the sense of
 * spec 4.1(4): "MUST begin with `./`".
 *
 * Backslashes are accepted after the leading `./` for Windows authors, but
 * the leading marker itself must be exactly `./` — `.\\x`, `x`, `/x` and
 * `../x` are all not plugin-relative.
 */
export function isPluginRelative(value: string): boolean {
	return value.startsWith('./');
}

/**
 * Resolves `target` to a real path, tolerating a target that does not exist.
 *
 * Walks up to the nearest existing ancestor, resolves *that* through
 * `realpath` (so every symlink on the existing part is followed), then
 * re-joins the non-existent remainder. The remainder cannot contain
 * symlinks, because it does not exist — a component created between this
 * check and the eventual open is a time-of-check/time-of-use gap that no
 * userspace path check can close; callers that execute (the stdio launcher)
 * additionally sit behind the ADR-018 execution gate.
 */
export async function resolveRealPath(target: string): Promise<string> {
	const absolute = resolve(target);
	const { root } = parse(absolute);
	let existing = absolute;
	const trailing: string[] = [];

	for (;;) {
		try {
			const real = await realpath(existing);
			return trailing.length > 0 ? join(real, ...trailing.reverse()) : real;
		} catch {
			if (existing === root || existing === dirname(existing)) {
				// Nothing on the chain exists (or the root itself is
				// unreadable): fall back to the lexically normalised path.
				return absolute;
			}
			trailing.push(existing.slice(dirname(existing).length + 1));
			existing = dirname(existing);
		}
	}
}

/**
 * True when `target` is the same path as `root` or lives underneath it.
 *
 * Both arguments must already be filesystem-resolved. Node's `win32`
 * implementation of `relative` compares case-insensitively, which is what we
 * want on Windows and harmless elsewhere.
 */
export function isWithinResolved(root: string, target: string): boolean {
	const rel = relative(root, target);
	if (rel === '') {
		return true;
	}
	if (isAbsolute(rel)) {
		// Different drive or UNC share — never contained.
		return false;
	}
	return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Outcome of a containment check. */
export type ContainmentResult =
	| { readonly ok: true; readonly resolved: string }
	| { readonly ok: false; readonly resolved: string; readonly reason: ContainmentFailure };

/** Why a containment check failed, for the caller's finding message. */
export type ContainmentFailure = 'escapes-root' | 'not-plugin-relative';

/**
 * Resolves a path supplied by the package and asserts it stays inside
 * `root`.
 *
 * @param root  The plugin root (or the plugin data directory, for
 *              `${PLUGIN_DATA}`-rooted values — spec 7.2.1 contains those
 *              against the data directory instead).
 * @param value An absolute path, or a path to resolve against `root`.
 * @param opts.requirePluginRelative
 *              Enforce spec 4.1(4) — the value must begin with `./`. Use it
 *              for fields the specification defines as plugin-relative
 *              paths; leave it off for values already expanded from
 *              `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` or for internal traversal.
 */
export async function resolveWithinRoot(
	root: string,
	value: string,
	opts?: { requirePluginRelative?: boolean }
): Promise<ContainmentResult> {
	if (opts?.requirePluginRelative && !isPluginRelative(value)) {
		return { ok: false, resolved: value, reason: 'not-plugin-relative' };
	}

	const realRoot = await resolveRealPath(root);
	const candidate = isAbsolute(value) ? value : join(realRoot, value);
	const resolved = await resolveRealPath(candidate);

	return isWithinResolved(realRoot, resolved)
		? { ok: true, resolved }
		: { ok: false, resolved, reason: 'escapes-root' };
}

/**
 * True when `path` is a regular file after following symlinks. Used for the
 * spec 6.2 "present but not the expected filesystem kind" checks and for the
 * spec 7.1 `SKILL.md` regular-file requirement.
 */
export async function isRegularFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** True when `path` is a directory after following symlinks. */
export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Whether a path exists and resolves, following symlinks.
 *
 * Note this is FALSE for a dangling symlink. For deciding whether a fixed
 * component location is *absent* — a question spec 6.2 answers very
 * differently from "present but broken" — use {@link pathPresent}.
 */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a directory entry exists at `path`, **without** following symlinks.
 *
 * This is the right question for spec 6.2, which draws a sharp line:
 *
 *   "If a fixed component location is absent, the client MUST NOT treat that
 *   as an error. If a fixed component location is present but does not
 *   resolve to the expected filesystem kind [...] the client MUST treat that
 *   component type as invalid."
 *
 * A dangling symlink named `skills` or `mcp.json` sits exactly on that line:
 * it IS present, and it does NOT resolve. Deciding absence with `stat` would
 * silently call it absent and load the package as though the author had
 * never shipped that component — hiding a broken package instead of
 * reporting it.
 */
export async function pathPresent(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Renders a path relative to the package root with POSIX separators, for findings. */
export function packageRelative(root: string, target: string): string {
	const rel = relative(root, target);
	return (rel === '' ? '.' : rel).split(sep).join('/');
}
