import path from 'node:path';

/**
 * Give a desktop install somewhere obvious to drop Agent Plugins packages.
 *
 * A DEFAULT only: an explicit `AGENT_PLUGINS_DIR` in the env file wins, so an
 * operator who has chosen a directory keeps it.
 *
 * The directory is created eagerly, because the alternative is a user
 * following a docs instruction to "put packages here" and finding no such
 * folder. Creation failure is swallowed: the package scanner treats a missing
 * directory as an empty registry, so a read-only profile degrades to "no
 * packages" rather than to a launch that fails.
 *
 * Exported and given an injected `mkdir` so it can be tested without an
 * Electron app object or a real filesystem — the logic worth testing is the
 * precedence rule and the failure tolerance, neither of which needs either.
 */
export function withDefaultPackagesDir(
	entries: Record<string, string>,
	userData: string,
	mkdir: (dir: string) => void
): Record<string, string> {
	if (entries.AGENT_PLUGINS_DIR) {
		return entries;
	}
	const packagesDir = path.join(userData, 'agent-plugins');
	try {
		mkdir(packagesDir);
	} catch {
		// Non-fatal by design; see above.
	}
	return { ...entries, AGENT_PLUGINS_DIR: packagesDir };
}
