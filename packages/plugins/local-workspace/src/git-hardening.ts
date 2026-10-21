import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Repository-hostile Git configuration, neutralised for the git commands a
 * NODE runs over an attacker-authored checkout (works-security finding 3,
 * fleet node 0.2.7; extends self-build slice AL).
 *
 * The finalize commit already ran with `core.hooksPath` → an empty directory
 * and `core.fsmonitor=false`. The commands that CHECK OUT files did not:
 * provisioning's `git worktree add` and a read-only mount's `reset --hard` /
 * `clean`. Those run a `post-checkout` / `reference-transaction` hook, an
 * fsmonitor command, and — the one that needs no hook at all — every FILTER
 * DRIVER a tracked `.gitattributes` names (`* filter=lfs` with Git for
 * Windows' system-level git-lfs config, or any driver a planted pool config
 * defines), each as the machine owner, before the model's first byte and
 * outside every permission mode it is held to.
 *
 * Everything here travels as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` /
 * `GIT_CONFIG_VALUE_<n>` — appended after any inherited entries so ours are
 * the last word over system, global AND the shared pool config a linked
 * worktree's `--local` writes land in — plus `GIT_LFS_SKIP_SMUDGE=1`. Never
 * written to any config file; it dies with the child.
 *
 * What is deliberately NOT touched: `core.symlinks` stays the platform's own
 * setting. Forcing it would make a checkout disagree with the index about
 * what a path IS, and the node's next `git add -A` would commit every symlink
 * as a plain file.
 */

/** One `filter.<driver>.<key>` entry as `git config --show-scope` reports it. */
export interface FilterDriverConfigEntry {
	scope: string;
	driver: string;
	key: string;
	value: string;
}

/** The filter-driver keys Git consults. */
const FILTER_KEYS = ['smudge', 'clean', 'process', 'required'] as const;

/** Scopes a repository (or a run with a shell) cannot write: the operator's own. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

/**
 * `git config` arguments that list every filter-driver key visible from a
 * directory, with the scope each one comes from. Exit 1 = none configured.
 */
export const FILTER_DRIVER_PROBE_ARGS: readonly string[] = [
	'config',
	'--show-scope',
	'--get-regexp',
	'^filter\\..+\\.(smudge|clean|process|required)$'
];

/** Parse {@link FILTER_DRIVER_PROBE_ARGS}' output (`<scope>\t<key> <value>` per line). */
export function parseFilterDriverConfig(stdout: string): FilterDriverConfigEntry[] {
	const entries: FilterDriverConfigEntry[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line) continue;
		const tab = line.indexOf('\t');
		if (tab <= 0) continue;
		const scope = line.slice(0, tab);
		const rest = line.slice(tab + 1);
		const space = rest.indexOf(' ');
		const name = space === -1 ? rest : rest.slice(0, space);
		const value = space === -1 ? '' : rest.slice(space + 1);
		if (!name.startsWith('filter.')) continue;
		const lastDot = name.lastIndexOf('.');
		const driver = name.slice('filter.'.length, lastDot);
		const key = name.slice(lastDot + 1).toLowerCase();
		if (!driver || !(FILTER_KEYS as readonly string[]).includes(key)) continue;
		entries.push({ scope, driver, key, value });
	}
	return entries;
}

/** A `GIT_CONFIG_KEY` cannot carry a newline; a driver name that does is skipped (Git could not have read it either). */
function usableDriverName(driver: string): boolean {
	return driver.length > 0 && !/[\r\n\0]/.test(driver);
}

/** Entries every hardened command gets: no hooks, no fsmonitor, no `ext::` transport, no submodule recursion. */
function baseHardeningEntries(hooksDir: string): Array<[string, string]> {
	return [
		['core.hooksPath', hooksDir.replace(/\\/g, '/')],
		['core.fsmonitor', 'false'],
		['protocol.ext.allow', 'never'],
		['submodule.recurse', 'false']
	];
}

/**
 * Overlay for a command that CHECKS OUT or compares files (`worktree add`,
 * `checkout`, `reset --hard`, `clean`, `fetch`): every filter driver visible
 * in `found` — and `lfs` whether or not it was seen — gets an empty
 * `smudge` / `clean` / `process` and `required=false`, so Git copies blobs
 * verbatim and runs nothing. LFS content therefore lands as pointer files on
 * a hardened checkout (`GIT_LFS_SKIP_SMUDGE=1` says the same to a git-lfs
 * that runs anyway).
 */
export function checkoutHardeningEntries(
	hooksDir: string,
	found: readonly FilterDriverConfigEntry[]
): Array<[string, string]> {
	const drivers = new Set<string>(['lfs']);
	for (const entry of found) if (usableDriverName(entry.driver)) drivers.add(entry.driver);
	const entries = baseHardeningEntries(hooksDir);
	for (const driver of drivers) {
		entries.push(
			[`filter.${driver}.smudge`, ''],
			[`filter.${driver}.clean`, ''],
			[`filter.${driver}.process`, ''],
			[`filter.${driver}.required`, 'false']
		);
	}
	return entries;
}

/**
 * Overlay for the node's own finalize (`add -A` / `status` / `commit`): the
 * `clean` filter MUST keep running there, or an LFS repository would get its
 * large files committed as raw blobs. So a driver keeps exactly the
 * definition the OPERATOR gave it (system / global / process-env scope), and
 * any driver key that a repository-writable scope (the shared pool config, a
 * worktree config) defines or overrides is pinned back to the operator's
 * value — or emptied when the operator never defined that driver.
 */
export function finalizeHardeningEntries(
	hooksDir: string,
	found: readonly FilterDriverConfigEntry[]
): Array<[string, string]> {
	const entries: Array<[string, string]> = [
		['core.hooksPath', hooksDir.replace(/\\/g, '/')],
		['core.fsmonitor', 'false']
	];
	const untrusted = new Set<string>();
	for (const entry of found) {
		if (!TRUSTED_SCOPES.has(entry.scope) && usableDriverName(entry.driver)) untrusted.add(entry.driver);
	}
	for (const driver of untrusted) {
		for (const key of FILTER_KEYS) {
			let trusted: string | undefined;
			for (const entry of found) {
				if (entry.driver === driver && entry.key === key && TRUSTED_SCOPES.has(entry.scope)) {
					trusted = entry.value; // last one wins, as in Git
				}
			}
			entries.push([`filter.${driver}.${key}`, trusted ?? (key === 'required' ? 'false' : '')]);
		}
	}
	return entries;
}

/**
 * Encode `entries` as `GIT_CONFIG_*` variables APPENDED after whatever
 * `GIT_CONFIG_COUNT` the child would otherwise inherit (an operator's pinned
 * settings survive; ours come last and win).
 */
export function gitConfigEnvOverlay(
	entries: ReadonlyArray<readonly [string, string]>,
	inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
	const parsed = Number.parseInt(String(inherited.GIT_CONFIG_COUNT ?? ''), 10);
	const base = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
	const env: Record<string, string> = { GIT_CONFIG_COUNT: String(base + entries.length) };
	entries.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${base + index}`] = key;
		env[`GIT_CONFIG_VALUE_${base + index}`] = value;
	});
	return env;
}

/** The complete environment overlay for a hardened CHECKOUT-type command. */
export function checkoutHardeningEnv(
	hooksDir: string,
	found: readonly FilterDriverConfigEntry[],
	inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
	return {
		...gitConfigEnvOverlay(checkoutHardeningEntries(hooksDir, found), inherited),
		GIT_LFS_SKIP_SMUDGE: '1'
	};
}

let emptyHooksDirPromise: Promise<string> | null = null;

/**
 * An EMPTY directory to point `core.hooksPath` at — created once per process.
 * Not `''`: on some commands an empty value resolves hooks relative to the
 * checkout the model controls.
 */
export function emptyHooksDir(): Promise<string> {
	return (emptyHooksDirPromise ??= (async () => {
		const dir = join(tmpdir(), `ew-no-hooks-${randomUUID()}`);
		await fs.mkdir(dir, { recursive: true });
		return dir;
	})().catch((error: unknown) => {
		emptyHooksDirPromise = null;
		throw error;
	}));
}
